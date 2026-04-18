#!/usr/bin/env bash
# Doc smoke tests for Issue #3 — verify README + llms.txt mention the
# multi-source workflow delivered by #1 and #2.
#
# Grep-based assertions are loose on purpose: the README is hand-written
# prose, not a schema. These tests catch "someone deleted the section"
# regressions, not formatting nits.
#
# Usage: tests/test_readme_docs.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
README="${ROOT}/README.md"
LLMS="${ROOT}/llms.txt"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[0;31m✗\033[0m %s\n    %s\n" "$1" "$2"; }

# --- Test 1: Sources subsection exists and mentions both sources ---
echo "Test 1: README Sources subsection"
sources_section=$(grep -A 12 '^## Sources' "$README")
if [ -z "$sources_section" ]; then
  fail "Sources heading" "expected '## Sources' section in README"
elif ! echo "$sources_section" | grep -q 'arxiv'; then
  fail "arxiv mention" "'arxiv' not mentioned inside Sources section"
elif ! echo "$sources_section" | grep -qi 'pubmed'; then
  fail "pubmed mention" "'pubmed' not mentioned inside Sources section"
else
  pass "Sources section documents both arxiv and pubmed"
fi

# --- Test 2: Usage block shows --source pubmed + pmid: get examples ---
echo "Test 2: Usage block multi-source examples"
if ! grep -q -- '--source pubmed' "$README"; then
  fail "--source pubmed" "no '--source pubmed' example in README"
elif ! grep -qE 'paper7 get pmid:' "$README"; then
  fail "pmid: get" "no 'paper7 get pmid:' example in README"
else
  pass "Usage shows both --source pubmed and paper7 get pmid: examples"
fi

# --- Test 3: CLI reference lists --source with arxiv|pubmed ---
echo "Test 3: CLI reference block"
ref_block=$(awk '/^## CLI reference/,/^---$/' "$README")
if ! echo "$ref_block" | grep -qE -- '--source'; then
  fail "CLI --source" "--source flag missing from CLI reference block"
elif ! echo "$ref_block" | grep -qE 'arxiv.*pubmed|pubmed.*arxiv'; then
  fail "CLI values" "both 'arxiv' and 'pubmed' not listed together in CLI reference"
else
  pass "CLI reference lists --source with arxiv|pubmed values"
fi

# --- Test 4: CLI reference mentions pmid: on get ---
echo "Test 4: CLI reference documents pmid: on get"
if ! echo "$ref_block" | grep -qE 'pmid:'; then
  fail "CLI pmid" "'pmid:' not mentioned in CLI reference block"
else
  pass "CLI reference documents pmid: prefix for get"
fi

# --- Test 5: llms.txt mentions pubmed and pmid: ---
echo "Test 5: llms.txt multi-source awareness"
if ! grep -qi 'pubmed' "$LLMS"; then
  fail "llms pubmed" "llms.txt does not mention PubMed"
elif ! grep -q 'pmid:' "$LLMS"; then
  fail "llms pmid" "llms.txt does not mention pmid: prefix"
else
  pass "llms.txt mentions both PubMed and pmid: prefix"
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
