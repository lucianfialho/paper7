#!/usr/bin/env bash
# Tests for `paper7 get <id> --abstract-only`.
# Hits real arXiv, PubMed, Crossref APIs.
# Usage: tests/test_abstract_only.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-${ROOT}/paper7.sh}"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[0;31m✗\033[0m %s\n    %s\n" "$1" "$2"; }

# --- Test 1: arXiv abstract-only ---
echo "Test 1: paper7 get arxiv:1706.03762 --abstract-only"
out=$("$PAPER7" get 1706.03762 --abstract-only --no-tldr 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "exit code" "expected 0, got $code; output:\n$out"
elif ! echo "$out" | grep -q "^# "; then
  fail "title line" "no '# <title>' line"
elif ! echo "$out" | grep -q "^## Abstract"; then
  fail "abstract heading" "expected '## Abstract' header"
elif echo "$out" | grep -q "^## Introduction\|^## References\|^## Conclusion"; then
  fail "no body sections" "found body section; --abstract-only should skip full text"
else
  pass "arXiv abstract-only fetched without body"
fi

# --- Test 2: PubMed abstract-only ---
echo "Test 2: paper7 get pmid:38903003 --abstract-only"
out=$("$PAPER7" get pmid:38903003 --abstract-only --no-tldr 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "exit code" "expected 0, got $code"
elif ! echo "$out" | grep -q "^# "; then
  fail "title" "no title line"
elif ! echo "$out" | grep -q "^## Abstract"; then
  fail "abstract heading" "missing"
else
  pass "PubMed abstract-only fetched"
fi

# --- Test 3: DOI abstract-only ---
echo "Test 3: paper7 get doi:10.1101/2023.12.15.571821 --abstract-only"
out=$("$PAPER7" get doi:10.1101/2023.12.15.571821 --abstract-only --no-tldr 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "exit code" "expected 0, got $code"
elif ! echo "$out" | grep -q "^# "; then
  fail "title" "no title line"
elif ! echo "$out" | grep -q "^\*\*DOI:\*\* 10.1101"; then
  fail "DOI line" "expected '**DOI:** 10.1101...'"
else
  pass "DOI abstract-only fetched"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
exit "$FAIL"
