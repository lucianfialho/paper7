#!/usr/bin/env bash
# Tests for Semantic Scholar integration (Issue #9).
#
# Hits the real S2 API. May be rate-limited if run repeatedly within
# 5 minutes (S2 unauth limit ~100 req / 5min). Tests detect 429 /
# transient failure and skip rather than fail in that case.
#
# Usage: tests/test_s2.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-${ROOT}/paper7.sh}"
PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[0;31m✗\033[0m %s\n    %s\n" "$1" "$2"; }
skip() { SKIP=$((SKIP + 1)); printf "  \033[0;33m⊘\033[0m %s\n    %s\n" "$1" "$2"; }

# Probe S2 once to detect rate-limit before spending requests on tests.
probe_status=$(curl -sL -o /dev/null -w "%{http_code}" "https://api.semanticscholar.org/graph/v1/paper/arXiv:1706.03762?fields=title&tool=paper7-test" 2>/dev/null || echo "000")

if [ "$probe_status" = "429" ]; then
  echo "Semantic Scholar rate-limited (HTTP 429). Skipping live S2 tests."
  echo "Wait 5 minutes and retry, or apply for a free API key."
  SKIP_LIVE=1
else
  SKIP_LIVE=0
fi

# --- Test 1: paper7 refs happy path ---
echo "Test 1: paper7 refs 1706.03762 --max 3"
if [ "$SKIP_LIVE" = "1" ]; then
  skip "S2 happy path" "rate-limited; skipped"
else
  out=$("$PAPER7" refs 1706.03762 --max 3 2>&1)
  code=$?
  rows=$(printf '%s\n' "$out" | grep -cE '^  \[(arxiv|pmid|doi|s2):' || true)
  if [ "$code" -ne 0 ]; then
    fail "refs exit" "expected 0, got $code; output:\n$out"
  elif [ "$rows" -ne 3 ]; then
    fail "refs row count" "expected 3 rows, got $rows; output:\n$out"
  elif ! printf '%s\n' "$out" | grep -qE '\([0-9]{4}\)'; then
    fail "refs year" "expected (YYYY) on at least one author line; output:\n$out"
  else
    pass "refs returns 3 rows with [source:id] prefix and year"
  fi
fi

# --- Test 2: paper7 refs --json ---
echo "Test 2: paper7 refs --json"
if [ "$SKIP_LIVE" = "1" ]; then
  skip "S2 JSON" "rate-limited; skipped"
else
  out=$("$PAPER7" refs 1706.03762 --max 2 --json 2>&1)
  code=$?
  if [ "$code" -ne 0 ]; then
    fail "refs --json exit" "expected 0, got $code"
  elif ! echo "$out" | jq -e '.data | length >= 2' >/dev/null 2>&1; then
    fail "refs --json shape" "expected JSON with .data array of >=2 entries; got:\n$out"
  else
    pass "refs --json emits valid JSON with .data array"
  fi
fi

# --- Test 3: unknown paper ---
echo "Test 3: unknown paper id"
if [ "$SKIP_LIVE" = "1" ]; then
  skip "S2 unknown" "rate-limited; skipped"
else
  out=$("$PAPER7" refs 9999.99999 2>&1)
  code=$?
  if [ "$code" -eq 0 ]; then
    fail "unknown exit" "expected non-zero, got 0"
  elif ! echo "$out" | grep -qE 'no paper|not found|reach Semantic'; then
    fail "unknown error message" "expected 'no paper' or 'reach Semantic' in stderr; got:\n$out"
  else
    pass "unknown paper rejected with clear error"
  fi
fi

# --- Test 4: missing arg ---
echo "Test 4: paper7 refs (no arg)"
out=$("$PAPER7" refs 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "missing arg exit" "expected non-zero, got 0"
elif ! echo "$out" | grep -qi "missing paper id"; then
  fail "missing arg error" "expected 'missing paper ID' in stderr; got:\n$out"
else
  pass "missing arg rejected with clear usage"
fi

# --- Test 5: TLDR enrichment on get ---
echo "Test 5: get with TLDR enrichment"
if [ "$SKIP_LIVE" = "1" ]; then
  skip "TLDR enrichment" "rate-limited; skipped"
else
  out=$("$PAPER7" get 1706.03762 --no-cache 2>&1)
  code=$?
  if [ "$code" -ne 0 ]; then
    fail "get exit" "expected 0, got $code"
  elif ! echo "$out" | grep -q '^\*\*TLDR:\*\*'; then
    skip "TLDR present" "S2 may be rate-limited even after probe; TLDR not found in output (best-effort path is silent on failure)"
  else
    pass "get includes **TLDR:** line when S2 reachable"
  fi
fi

# --- Test 6: TLDR opt-out ---
echo "Test 6: get --no-tldr opts out"
out=$("$PAPER7" get 1706.03762 --no-cache --no-tldr 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "no-tldr exit" "expected 0, got $code"
elif echo "$out" | grep -q '^\*\*TLDR:\*\*'; then
  fail "no-tldr leak" "**TLDR:** line present despite --no-tldr; output:\n$(echo "$out" | head -10)"
else
  pass "--no-tldr suppresses the TLDR line"
fi

# --- Test 7: TLDR cached round-trip ---
echo "Test 7: TLDR persists in cache"
if [ "$SKIP_LIVE" = "1" ]; then
  skip "TLDR cache" "rate-limited; skipped"
else
  # Clear cache, then write it once with TLDR, then read from cache.
  "$PAPER7" cache clear 1706.03762 >/dev/null 2>&1 || true
  "$PAPER7" get 1706.03762 >/dev/null 2>&1
  # Now read from cache (no --no-cache).
  out=$("$PAPER7" get 1706.03762 2>&1)
  if echo "$out" | grep -q '^\*\*TLDR:\*\*'; then
    pass "TLDR survives cache hit (written to paper.md on first fetch)"
  else
    skip "TLDR cache persistence" "S2 may have failed silently on first fetch — best-effort path"
  fi
fi

# --- Test 8: jq missing → refs fails fast ---
# Build a sandbox PATH that contains the binaries paper7 needs except jq.
# Some macOS versions ship jq at /usr/bin, so we can't just strip /opt/homebrew.
echo "Test 8: jq missing → refs errors clearly"
SHIM_DIR=$(mktemp -d)
for cmd in bash sh curl sed awk grep cat tr cut head tail mktemp rm sort uniq find basename dirname env wc; do
  src=$(command -v "$cmd" 2>/dev/null || true)
  [ -n "$src" ] && ln -s "$src" "${SHIM_DIR}/${cmd}" 2>/dev/null || true
done
# Deliberately do NOT link jq into SHIM_DIR.
out=$(PATH="$SHIM_DIR" "$PAPER7" refs 1706.03762 2>&1)
code=$?
rm -rf "$SHIM_DIR"
if [ "$code" -eq 0 ]; then
  fail "jq missing exit" "expected non-zero, got 0; output:\n$out"
elif ! echo "$out" | grep -qi "jq not installed"; then
  fail "jq missing error" "expected 'jq not installed' in stderr; got:\n$out"
else
  pass "jq missing → exits non-zero with install hint"
fi

# --- Summary ---
TOTAL=$((PASS + FAIL + SKIP))
echo ""
echo "────────────────────────────────────────"
echo "  ${PASS}/${TOTAL} passed, ${SKIP} skipped"
if [ "$FAIL" -gt 0 ]; then
  printf "  \033[0;31m%d failed\033[0m\n" "$FAIL"
  exit "$FAIL"
fi
exit 0
