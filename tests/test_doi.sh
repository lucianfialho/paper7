#!/usr/bin/env bash
# Tests for `paper7 get doi:<DOI>` (Issue #11).
#
# Hits real Crossref API. Crossref has very generous rate limits with the
# polite mailto, so transient failures are rare — no skip-on-429 needed.
#
# Usage: tests/test_doi.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-${ROOT}/paper7.sh}"
TEST_DOI="10.1101/2023.12.15.571821"
TEST_DIR_SUFFIX="10.1101_2023.12.15.571821"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[0;31m✗\033[0m %s\n    %s\n" "$1" "$2"; }

# Clean any leftover state from previous runs.
rm -rf "${HOME}/.paper7/cache/doi-${TEST_DIR_SUFFIX}" 2>/dev/null || true

# --- Test 1: bioRxiv DOI happy path ---
echo "Test 1: paper7 get doi:${TEST_DOI}"
out=$("$PAPER7" get "doi:${TEST_DOI}" --no-tldr 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "exit code" "expected 0, got $code; output:\n$out"
elif ! echo "$out" | grep -q "^# "; then
  fail "title line" "no '# <title>' line in output"
elif ! echo "$out" | grep -q "^\*\*DOI:\*\* ${TEST_DOI}\$"; then
  fail "DOI line" "expected '**DOI:** ${TEST_DOI}'"
elif ! echo "$out" | grep -q "^\*\*Full text:\*\*"; then
  fail "Full text line" "expected '**Full text:**' line"
elif ! echo "$out" | grep -q "^## Abstract\$"; then
  fail "Abstract section" "missing '## Abstract' header"
elif [ ! -f "${HOME}/.paper7/cache/doi-${TEST_DIR_SUFFIX}/paper.md" ]; then
  fail "cache paper.md" "expected cache file at doi-${TEST_DIR_SUFFIX}/paper.md"
elif [ ! -f "${HOME}/.paper7/cache/doi-${TEST_DIR_SUFFIX}/meta.json" ]; then
  fail "cache meta.json" "expected meta.json"
elif ! grep -q "\"id\":\"doi:${TEST_DOI}\"" "${HOME}/.paper7/cache/doi-${TEST_DIR_SUFFIX}/meta.json"; then
  fail "meta.json id" "expected canonical id 'doi:${TEST_DOI}' in meta.json"
else
  pass "bioRxiv DOI fetched, parsed, and cached with canonical id"
fi

# --- Test 2: arXiv-DOI auto-redirect ---
echo "Test 2: arXiv-DOI silently redirects to arXiv path"
out=$("$PAPER7" get "doi:10.48550/arXiv.1706.03762" --no-cache --no-tldr 2>&1)
code=$?
# Should reuse arxiv cache (1706.03762/), not create a doi-10.48550_arXiv.X dir
if [ "$code" -ne 0 ]; then
  fail "arXiv-DOI exit" "expected 0, got $code"
elif [ -d "${HOME}/.paper7/cache/doi-10.48550_arXiv.1706.03762" ]; then
  fail "arXiv-DOI dup dir" "should not have created doi-10.48550_arXiv.1706.03762/ — should reuse arxiv cache"
elif [ ! -d "${HOME}/.paper7/cache/1706.03762" ]; then
  fail "arXiv cache" "expected arxiv cache at 1706.03762/"
elif ! echo "$out" | grep -q "Attention Is All You Need"; then
  fail "arXiv-DOI content" "expected Attention paper content"
else
  pass "arXiv-DOI redirects to existing arXiv path (no doi-* dup)"
fi

# --- Test 3: invalid DOI ---
echo "Test 3: invalid DOI format"
out=$("$PAPER7" get "doi:not-a-doi" 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "invalid DOI exit" "expected non-zero, got 0"
elif ! echo "$out" | grep -qi "invalid doi"; then
  fail "invalid DOI error" "expected 'invalid DOI' in stderr; got:\n$out"
else
  pass "invalid DOI rejected with clear error"
fi

# --- Test 4: empty after prefix ---
echo "Test 4: paper7 get doi: (empty)"
out=$("$PAPER7" get "doi:" 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "empty doi exit" "expected non-zero, got 0"
elif ! echo "$out" | grep -qi "invalid doi"; then
  fail "empty doi error" "expected 'invalid DOI'; got:\n$out"
else
  pass "empty doi: rejected with clear error"
fi

# --- Test 5: list shows doi: prefix ---
echo "Test 5: paper7 list shows doi:<DOI> with colon"
out=$("$PAPER7" list 2>&1)
if ! echo "$out" | grep -qE "doi:${TEST_DOI}([[:space:]]|\$)"; then
  fail "list doi entry" "expected 'doi:${TEST_DOI}' in list output; got:\n$out"
else
  pass "list shows doi: with colon (canonical form, not dir-name dash)"
fi

# --- Test 6: cache clear by DOI ---
echo "Test 6: paper7 cache clear doi:${TEST_DOI}"
out=$("$PAPER7" cache clear "doi:${TEST_DOI}" 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "cache clear exit" "expected 0, got $code"
elif [ -d "${HOME}/.paper7/cache/doi-${TEST_DIR_SUFFIX}" ]; then
  fail "cache dir removed" "${HOME}/.paper7/cache/doi-${TEST_DIR_SUFFIX} still exists"
elif ! echo "$out" | grep -qE "Removed paper doi:${TEST_DOI}"; then
  fail "cache clear message" "expected 'Removed paper doi:${TEST_DOI}'; got:\n$out"
else
  pass "cache clear removes doi-* directory"
fi

# After clear, list should not show it
out=$("$PAPER7" list 2>&1)
if echo "$out" | grep -qE "doi:${TEST_DOI}([[:space:]]|\$)"; then
  fail "list after clear" "doi:${TEST_DOI} still appears after clear"
else
  pass "list no longer shows cleared doi"
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
