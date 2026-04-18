#!/usr/bin/env bash
# Smoke tests for `paper7 get pmid:NNN` (Issue #2).
#
# Hits the real NCBI efetch endpoint, so requires network access.
# Uses a stable well-known PMID (38903003 — hypertensive emergency case
# surfaced by Issue #1's dogfooding).
#
# Usage: tests/test_pubmed_get.sh

set -u

PAPER7="${PAPER7:-$(cd "$(dirname "$0")/.." && pwd)/paper7.sh}"
PMID="38903003"
DIR="${HOME}/.paper7/cache/pmid-${PMID}"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[0;31m✗\033[0m %s\n    %s\n" "$1" "$2"; }

# Clean slate before each test
reset_cache() { rm -rf "$DIR"; }

# --- Test 1: Happy path ---
echo "Test 1: paper7 get pmid:${PMID}"
reset_cache
out=$("$PAPER7" get "pmid:${PMID}" 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "fetch exit code" "expected 0, got $code"
elif ! echo "$out" | grep -q "^# "; then
  fail "markdown title" "expected '# <title>' line"
elif ! echo "$out" | grep -q "## Abstract"; then
  fail "abstract section" "expected '## Abstract' header"
elif ! echo "$out" | grep -q "Authors:"; then
  fail "authors line" "expected '**Authors:**' line"
elif ! echo "$out" | grep -q "https://pubmed.ncbi.nlm.nih.gov/${PMID}"; then
  fail "PubMed URL" "expected PubMed URL in header"
elif [ ! -f "${DIR}/paper.md" ]; then
  fail "cache paper.md" "expected ${DIR}/paper.md to exist"
elif [ ! -f "${DIR}/meta.json" ]; then
  fail "cache meta.json" "expected ${DIR}/meta.json to exist"
elif ! grep -q "\"id\":\"pmid:${PMID}\"" "${DIR}/meta.json"; then
  fail "meta.json id" "expected \"id\":\"pmid:${PMID}\" in meta.json"
else
  pass "fetches, writes Markdown + meta.json with matching id"
fi

# --- Test 2: Cache hit on second call ---
echo "Test 2: second call uses cache"
out=$("$PAPER7" get "pmid:${PMID}" 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "cached fetch exit" "expected 0, got $code"
elif ! echo "$out" | grep -q "^# "; then
  fail "cached title" "expected title line in output"
else
  pass "second call returns cached markdown"
fi

# --- Test 3: --no-cache forces refetch ---
echo "Test 3: --no-cache still works"
out=$("$PAPER7" get "pmid:${PMID}" --no-cache 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "--no-cache exit" "expected 0, got $code"
elif [ ! -f "${DIR}/paper.md" ]; then
  fail "--no-cache cache" "expected paper.md to still exist after refetch"
else
  pass "--no-cache refetches and leaves cache intact"
fi

# --- Test 4: arXiv regression (no pmid dispatch) ---
echo "Test 4: arXiv path still works"
# Use a well-known arXiv ID that should already be cached or fetchable
out=$("$PAPER7" get "1706.03762" 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "arXiv exit" "expected 0, got $code"
elif ! echo "$out" | grep -q "Attention Is All You Need"; then
  fail "arXiv content" "expected 'Attention Is All You Need' in output"
elif echo "$out" | grep -q "PubMed"; then
  fail "arXiv leak" "arXiv output unexpectedly contains 'PubMed'"
else
  pass "arXiv IDs still resolve via arXiv path (no regression)"
fi

# --- Test 5: cmd_list shows PMID with prefix ---
echo "Test 5: list shows pmid:NNN"
out=$("$PAPER7" list 2>&1)
if ! echo "$out" | grep -qE "pmid:${PMID}[[:space:]]"; then
  fail "list pmid prefix" "expected 'pmid:${PMID}' in list output"
elif ! echo "$out" | grep -q "1706.03762"; then
  fail "list arXiv coexist" "expected arXiv entry to coexist with pmid entry"
else
  pass "list shows pmid with ':' separator and arXiv entries coexist"
fi

# --- Test 6: cache clear by pmid ---
echo "Test 6: cache clear pmid:${PMID}"
out=$("$PAPER7" cache clear "pmid:${PMID}" 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "cache clear exit" "expected 0, got $code"
elif [ -d "$DIR" ]; then
  fail "cache dir removed" "directory ${DIR} still exists"
elif ! echo "$out" | grep -q "Removed paper pmid:${PMID}"; then
  fail "cache clear message" "expected 'Removed paper pmid:${PMID}'"
else
  pass "cache clear removes pmid-NNN directory"
fi

# After cache clear, list should no longer show it
out=$("$PAPER7" list 2>&1)
if echo "$out" | grep -qE "pmid:${PMID}[[:space:]]"; then
  fail "list after clear" "pmid:${PMID} still appears in list after clear"
else
  pass "list no longer shows cleared pmid"
fi

# --- Test 7: Invalid PMID format ---
echo "Test 7: invalid pmid format"
out=$("$PAPER7" get "pmid:abc123" 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "invalid pmid exit" "expected non-zero, got 0"
elif ! echo "$out" | grep -qi "invalid pubmed id"; then
  fail "invalid pmid error" "expected 'invalid PubMed ID' in stderr"
else
  pass "invalid pmid rejected with clear error"
fi

# --- Test 8: Empty after prefix ---
echo "Test 8: pmid: (empty) rejected"
out=$("$PAPER7" get "pmid:" 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "empty pmid exit" "expected non-zero, got 0"
elif ! echo "$out" | grep -qi "invalid pubmed id"; then
  fail "empty pmid error" "expected 'invalid PubMed ID' in stderr"
else
  pass "empty pmid: rejected with clear error"
fi

# --- Summary ---
TOTAL=$((PASS + FAIL))
echo ""
echo "────────────────────────────────────────"
echo "  ${PASS}/${TOTAL} passed"
if [ "$FAIL" -gt 0 ]; then
  printf "  \033[0;31m%d failed\033[0m\n" "$FAIL"
  exit "$FAIL"
fi
exit 0
