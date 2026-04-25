#!/usr/bin/env bash
# Tests for `paper7 cite <id> --format <bibtex|apa|abnt>`.
# Hits real arXiv / Crossref / PubMed APIs.
# Usage: tests/test_cite.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-${ROOT}/paper7.sh}"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[0;31m✗\033[0m %s\n    %s\n" "$1" "$2"; }

# --- Test 1: BibTeX from arXiv ID ---
echo "Test 1: paper7 cite 1706.03762 --format bibtex"
out=$("$PAPER7" cite 1706.03762 --format bibtex 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "exit code" "expected 0, got $code; output:\n$out"
elif ! echo "$out" | grep -q "^@"; then
  fail "BibTeX entry type" "expected line starting with '@'"
elif ! echo "$out" | grep -qi "vaswani"; then
  fail "author" "expected 'Vaswani' in output"
elif ! echo "$out" | grep -q "2017"; then
  fail "year" "expected 2017"
elif ! echo "$out" | grep -qi "attention"; then
  fail "title" "expected 'attention' in title"
else
  pass "BibTeX from arXiv ID"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
exit "$FAIL"
