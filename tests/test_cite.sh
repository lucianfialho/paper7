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

# --- Test 2: APA from DOI ---
echo "Test 2: paper7 cite doi:10.1126/science.1439786 --format apa"
out=$("$PAPER7" cite doi:10.1126/science.1439786 --format apa 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "exit code" "expected 0, got $code; output:\n$out"
elif ! echo "$out" | grep -qi "dumbacher"; then
  fail "author" "expected 'Dumbacher' in APA output"
elif ! echo "$out" | grep -q "(1992)"; then
  fail "year" "expected '(1992)'"
elif ! echo "$out" | grep -q "https://doi.org/10.1126/science.1439786"; then
  fail "DOI url" "expected 'https://doi.org/...'"
else
  pass "APA from DOI"
fi

# --- Test 3: ABNT from PMID ---
echo "Test 3: paper7 cite pmid:38903003 --format abnt"
out=$("$PAPER7" cite pmid:38903003 --format abnt 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "exit code" "expected 0, got $code; output:\n$out"
elif ! echo "$out" | grep -q "[A-Z]"; then
  fail "uppercase surnames" "expected last names in ALL CAPS"
elif ! echo "$out" | grep -qE "(2024|2025)"; then
  fail "year" "expected 2024 or 2025"
else
  pass "ABNT from PMID"
fi

# --- Test 4: Unknown format errors ---
echo "Test 4: paper7 cite 1706.03762 --format yaml"
out=$("$PAPER7" cite 1706.03762 --format yaml 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "exit code" "expected non-zero for unknown format, got 0"
elif ! echo "$out" | grep -qi "unknown format"; then
  fail "error message" "expected 'unknown format' in stderr"
else
  pass "unknown format rejected"
fi

# --- Test 5: Missing ID errors ---
echo "Test 5: paper7 cite --format bibtex (no ID)"
out=$("$PAPER7" cite --format bibtex 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "exit code" "expected non-zero for missing ID"
elif ! echo "$out" | grep -qi "missing"; then
  fail "error message" "expected 'missing' in stderr"
else
  pass "missing ID rejected"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
exit "$FAIL"
