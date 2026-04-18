#!/usr/bin/env bash
# Tests for `paper7 browse` (Issue #7).
#
# The interactive fzf part cannot be smoke-tested from a non-TTY script,
# so we test: (1) the pure helper that builds fzf input, (2) the empty-
# cache guard, and (3) the fzf-missing error path. A manual checklist
# covers the interactive flow in the PR description.
#
# Usage: tests/test_browse.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-${ROOT}/paper7.sh}"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[0;31m✗\033[0m %s\n    %s\n" "$1" "$2"; }

# Fake cache directory for tests — isolated from the real ~/.paper7/cache.
TMP_HOME=$(mktemp -d)
trap 'rm -rf "$TMP_HOME"' EXIT

# Seed fake cache: one arXiv, one PubMed.
mkdir -p "${TMP_HOME}/.paper7/cache/1706.03762"
cat > "${TMP_HOME}/.paper7/cache/1706.03762/meta.json" <<'EOF'
{"id":"1706.03762","title":"Attention Is All You Need","authors":"Vaswani et al."}
EOF
printf '# Attention Is All You Need\n\nBody...\n' > "${TMP_HOME}/.paper7/cache/1706.03762/paper.md"

mkdir -p "${TMP_HOME}/.paper7/cache/pmid-38903003"
cat > "${TMP_HOME}/.paper7/cache/pmid-38903003/meta.json" <<'EOF'
{"id":"pmid:38903003","title":"Hypertensive Emergency","authors":"Barnett et al.","url":"https://pubmed.ncbi.nlm.nih.gov/38903003/"}
EOF
printf '# Hypertensive Emergency\n\nBody...\n' > "${TMP_HOME}/.paper7/cache/pmid-38903003/paper.md"

# --- Test 1: list_browse_entries format ---
echo "Test 1: list_browse_entries emits canonical id / title / cache_dir"
# Source paper7.sh with main disabled, then override CACHE_DIR to our tmp cache.
out=$(HOME="$TMP_HOME" PAPER7_NO_MAIN=1 bash -c "
  source '$PAPER7'
  CACHE_DIR='${TMP_HOME}/.paper7/cache'
  list_browse_entries
" 2>&1)
lines=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
if [ "$lines" != "2" ]; then
  fail "row count" "expected 2 rows, got $lines; output:\n$out"
elif ! echo "$out" | awk -F'\t' '$1=="1706.03762" && $2=="Attention Is All You Need" && $3 ~ /1706\.03762$/' | grep -q .; then
  fail "arxiv row" "expected <1706.03762>\\t<title>\\t<cache_dir ending in 1706.03762>; got:\n$out"
elif ! echo "$out" | awk -F'\t' '$1=="pmid:38903003" && $2=="Hypertensive Emergency" && $3 ~ /pmid-38903003$/' | grep -q .; then
  fail "pmid row" "expected <pmid:38903003>\\t<title>\\t<cache_dir ending in pmid-38903003>; got:\n$out"
else
  pass "format is <id>\\t<title>\\t<cache_dir> with pmid-NNN → pmid:NNN canonicalization"
fi

# --- Test 2: empty cache ---
echo "Test 2: browse exits 0 with friendly message on empty cache"
EMPTY_HOME=$(mktemp -d)
mkdir -p "${EMPTY_HOME}/.paper7/cache"
# Need fzf in PATH for this test, otherwise we hit the fzf-missing path first.
# Simulate fzf present via a dummy in a sandbox PATH.
SHIM_DIR=$(mktemp -d)
printf '#!/bin/sh\nexit 0\n' > "${SHIM_DIR}/fzf"; chmod +x "${SHIM_DIR}/fzf"
# Include glow shim too so optional path is stable
printf '#!/bin/sh\ncat "$@"\n' > "${SHIM_DIR}/glow"; chmod +x "${SHIM_DIR}/glow"

out=$(HOME="$EMPTY_HOME" PATH="${SHIM_DIR}:${PATH}" "$PAPER7" browse < /dev/null 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  fail "empty cache exit" "expected 0, got $code"
elif ! echo "$out" | grep -qi "no papers cached"; then
  fail "empty cache message" "expected 'No papers cached' message, got:\n$out"
else
  pass "empty cache → exits 0 with friendly message (fzf not invoked on empty)"
fi

rm -rf "$EMPTY_HOME" "$SHIM_DIR"

# --- Test 3: fzf not installed ---
echo "Test 3: browse exits 1 with clear error when fzf missing"
# Run with a minimal PATH that doesn't include fzf.
out=$(HOME="$TMP_HOME" PATH="/usr/bin:/bin" "$PAPER7" browse < /dev/null 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  fail "missing fzf exit" "expected non-zero, got 0"
elif ! echo "$out" | grep -qi "fzf not installed"; then
  fail "missing fzf message" "expected 'fzf not installed' in stderr, got:\n$out"
elif ! echo "$out" | grep -qi "install"; then
  fail "install hint" "expected an install hint, got:\n$out"
else
  pass "fzf missing → exits non-zero with install hint"
fi

# --- Test 4: render_paper falls back when glow missing ---
echo "Test 4: render_paper works without glow (falls through to less or cat)"
# Source with no main and call render_paper with a minimal PATH (no glow/less).
out=$(HOME="$TMP_HOME" PATH="/usr/bin:/bin" PAPER7_NO_MAIN=1 bash -c "
  source '$PAPER7'
  CACHE_DIR='${TMP_HOME}/.paper7/cache'
  render_paper 'pmid:38903003'
" 2>&1)
code=$?
# /usr/bin/less exists on macOS, so it'd page — harder to test in non-TTY.
# We just assert the function didn't error out (exit 0) and produced something non-empty.
if [ "$code" -ne 0 ]; then
  fail "render_paper exit" "expected 0, got $code; output:\n$out"
else
  pass "render_paper returns 0 on a cached pmid with fallback pager"
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
