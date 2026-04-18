#!/usr/bin/env bash
# Smoke tests for `paper7 search --source pubmed` (Issue #1).
#
# Hits the real NCBI E-utilities endpoint, so requires network access.
# Designed to be fast (3 small queries) and conservative with NCBI rate limits.
#
# Usage:
#   tests/test_pubmed_search.sh
#
# Exits 0 if all tests pass, non-zero with the number of failures otherwise.

set -u

PAPER7="${PAPER7:-$(cd "$(dirname "$0")/.." && pwd)/paper7.sh}"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[0;31m✗\033[0m %s\n  %s\n" "$1" "$2"; }

run() {
  local name="$1"; shift
  local output
  output=$("$@" 2>&1)
  local code=$?
  echo "$code|$output"
}

# --- Test 1: PubMed happy path ---
echo "Test 1: PubMed happy path (happy — covid, --max 3)"
out=$("$PAPER7" search "covid" --source pubmed --max 3 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "PubMed exit code" "expected 0, got $code; output: $out"
elif ! echo "$out" | grep -qE '^\s*\[pmid:[0-9]+\]'; then
  fail "PubMed ID format" "no [pmid:NNN] lines in output"
elif [ "$(echo "$out" | grep -cE '^\s*\[pmid:[0-9]+\]')" -ne 3 ]; then
  fail "PubMed result count" "expected 3 results, got $(echo "$out" | grep -cE '^\s*\[pmid:[0-9]+\]')"
elif ! echo "$out" | grep -qE '\([0-9]{4}'; then
  fail "PubMed date line" "no (YYYY...) date pattern found"
else
  pass "PubMed search returns 3 results with [pmid:NNN] prefix and dated author line"
fi

# --- Test 2: arXiv regression (no --source flag) ---
echo "Test 2: arXiv regression (no --source, default behavior)"
out=$("$PAPER7" search "attention" --max 2 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "arXiv exit code" "expected 0, got $code"
elif echo "$out" | grep -qE '\[pmid:'; then
  fail "arXiv regression" "unexpected pmid: prefix in arxiv output"
elif ! echo "$out" | grep -qE '\[[0-9]{4}\.[0-9]{4,5}\]'; then
  fail "arXiv ID format" "no [YYMM.NNNNN] pattern in output"
else
  pass "default arXiv search still emits YYMM.NNNNN IDs (no regression)"
fi

# --- Test 3: Explicit --source arxiv ---
echo "Test 3: Explicit --source arxiv"
out=$("$PAPER7" search "transformer" --source arxiv --max 2 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "explicit arxiv exit code" "expected 0, got $code"
elif ! echo "$out" | grep -qE '\[[0-9]{4}\.[0-9]{4,5}\]'; then
  fail "explicit arxiv format" "no arxiv IDs found"
else
  pass "--source arxiv behaves identically to default"
fi

# --- Test 4: Invalid source ---
echo "Test 4: Invalid --source value"
out=$("$PAPER7" search "x" --source bogus 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "invalid source exit" "expected non-zero, got 0"
elif ! echo "$out" | grep -qi "unknown source"; then
  fail "invalid source error" "expected 'unknown source' in stderr, got: $out"
else
  pass "invalid --source exits non-zero with clear error"
fi

# --- Test 5: Empty query with pubmed ---
echo "Test 5: Empty query with --source pubmed"
out=$("$PAPER7" search --source pubmed 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "empty query exit" "expected non-zero, got 0"
elif ! echo "$out" | grep -qi "missing search query"; then
  fail "empty query error" "expected 'missing search query', got: $out"
else
  pass "empty query with pubmed exits non-zero with 'missing search query'"
fi

# --- Test 6: Help mentions --source ---
echo "Test 6: search --help documents --source"
out=$("$PAPER7" search --help 2>&1)
if ! echo "$out" | grep -q -- "--source"; then
  fail "help --source" "--source not mentioned in help output"
elif ! echo "$out" | grep -qE "arxiv.*pubmed|pubmed.*arxiv"; then
  fail "help values" "both 'arxiv' and 'pubmed' values not documented"
else
  pass "--help lists --source with arxiv|pubmed values"
fi

# --- Summary ---
TOTAL=$((PASS + FAIL))
echo ""
echo "────────────────────────────────────────"
echo "  ${PASS}/${TOTAL} passed"
if [ "$FAIL" -gt 0 ]; then
  echo "  \033[0;31m${FAIL} failed\033[0m"
  exit "$FAIL"
fi
exit 0
