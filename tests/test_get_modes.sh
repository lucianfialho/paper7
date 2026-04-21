#!/usr/bin/env bash
# Tests for compact vs detailed get output.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-${ROOT}/paper7.sh}"
ARXIV_ID="1706.03762"
PMID="38903003"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[0;31m✗\033[0m %s\n    %s\n" "$1" "$2"; }

echo "Test 1: compact get emits summary + index"
out=$("$PAPER7" get "$ARXIV_ID" --no-cache --no-tldr 2>&1)
code=$?
line_count=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
if [ "$code" -ne 0 ]; then
  fail "compact exit" "expected 0, got $code; output:\n$out"
elif ! printf '%s\n' "$out" | grep -q '^\*\*Summary:\*\*'; then
  fail "compact summary" "expected **Summary:** line; output:\n$out"
elif ! printf '%s\n' "$out" | grep -q '^\*\*Index:\*\*'; then
  fail "compact index" "expected **Index:** section; output:\n$out"
elif ! printf '%s\n' "$out" | grep -q -- '--detailed --range START:END'; then
  fail "compact fetch hint" "expected detailed range hint; output:\n$out"
elif [ "$line_count" -ge 80 ]; then
  fail "compact line count" "expected compact output, got ${line_count} lines"
else
  pass "default get returns compact indexed header for long papers"
fi

echo "Test 2: detailed get returns full paper"
out=$("$PAPER7" get "$ARXIV_ID" --detailed --no-tldr 2>&1)
code=$?
line_count=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
if [ "$code" -ne 0 ]; then
  fail "detailed exit" "expected 0, got $code; output:\n$out"
elif ! printf '%s\n' "$out" | grep -q '^## Introduction$'; then
  fail "detailed body" "expected full paper body with ## Introduction; output:\n$(printf '%s\n' "$out" | sed -n '1,40p')"
elif [ "$line_count" -lt 150 ]; then
  fail "detailed line count" "expected long detailed output, got ${line_count} lines"
else
  pass "--detailed returns the full paper"
fi

echo "Test 3: detailed range slices full paper"
out=$("$PAPER7" get "$ARXIV_ID" --detailed --range 33:40 --no-tldr 2>&1)
code=$?
line_count=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
if [ "$code" -ne 0 ]; then
  fail "range exit" "expected 0, got $code; output:\n$out"
elif ! printf '%s\n' "$out" | grep -q '^# Attention Is All You Need (lines 33-40)$'; then
  fail "range header" "expected wrapped title header; output:\n$out"
elif ! printf '%s\n' "$out" | grep -q '^## Introduction$'; then
  fail "range body" "expected requested section lines; output:\n$out"
elif [ "$line_count" -ge 20 ]; then
  fail "range line count" "expected short ranged output, got ${line_count} lines"
else
  pass "--detailed --range returns only the requested line slice"
fi

echo "Test 4: range requires detailed"
out=$("$PAPER7" get "$ARXIV_ID" --range 33:40 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "range gate exit" "expected non-zero, got 0"
elif ! printf '%s\n' "$out" | grep -q -- '--range requires --detailed'; then
  fail "range gate message" "expected detailed-only error; output:\n$out"
else
  pass "--range is rejected without --detailed"
fi

echo "Test 5: short PubMed papers still render fully by default"
TMP_HOME=$(mktemp -d)
mkdir -p "${TMP_HOME}/.paper7/cache/pmid-${PMID}"
cat > "${TMP_HOME}/.paper7/cache/pmid-${PMID}/paper.md" <<EOF
# Short Paper

**Authors:** Example Author
**PubMed:** https://pubmed.ncbi.nlm.nih.gov/${PMID}/

---

## Abstract

Brief abstract.
EOF
out=$(HOME="$TMP_HOME" "$PAPER7" get "pmid:${PMID}" --no-tldr 2>&1)
code=$?
rm -rf "$TMP_HOME"
if [ "$code" -ne 0 ]; then
  fail "short paper exit" "expected 0, got $code; output:\n$out"
elif ! printf '%s\n' "$out" | grep -q '^## Abstract$'; then
  fail "short paper body" "expected full PubMed abstract output; output:\n$out"
elif printf '%s\n' "$out" | grep -q '^\*\*Index:\*\*'; then
  fail "short paper compact" "did not expect index for short PubMed output; output:\n$out"
else
  pass "short papers skip the compact indexed header"
fi

echo "Test 6: index includes single-hash (#) headers"
TMP_HOME=$(mktemp -d)
mkdir -p "${TMP_HOME}/.paper7/cache/2401.00001"
cat > "${TMP_HOME}/.paper7/cache/2401.00001/paper.md" <<'EOF'
# Root Title

**Authors:** A B
**arXiv:** https://arxiv.org/abs/2401.00001

---

# First Top Section
Content line 1.
Content line 2.
Content line 3.
Content line 4.
Content line 5.
Content line 6.
Content line 7.
Content line 8.
Content line 9.
Content line 10.

## Subsection A
Sub content.

# Second Top Section
More content.
More content 2.
More content 3.
More content 4.
More content 5.
More content 6.
More content 7.
More content 8.
More content 9.
More content 10.

## Subsection B
More sub content.
EOF
out=$(HOME="$TMP_HOME" "$PAPER7" get "2401.00001" --no-tldr 2>&1)
code=$?
rm -rf "$TMP_HOME"
if [ "$code" -ne 0 ]; then
  fail "hash header exit" "expected 0, got $code; output:\n$out"
elif ! printf '%s\n' "$out" | grep -q '| First Top Section |'; then
  fail "hash header index" "expected single-hash section in index; output:\n$out"
elif ! printf '%s\n' "$out" | grep -q '| Subsection A |'; then
  fail "hash header subindex" "expected subsection in index; output:\n$out"
else
  pass "single-hash (#) headers appear in the compact index"
fi

TOTAL=$((PASS + FAIL))
echo ""
echo "────────────────────────────────────────"
echo "  ${PASS}/${TOTAL} passed"
if [ "$FAIL" -gt 0 ]; then
  printf "  \033[0;31m%d failed\033[0m\n" "$FAIL"
  exit "$FAIL"
fi
exit 0
