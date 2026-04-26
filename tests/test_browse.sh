#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

home=$(mktemp -d)
shim_dir=$(mktemp -d)
trap 'rm -rf "$home" "$shim_dir"' EXIT

mkdir -p "$home/.paper7/cache/1706.03762"
printf '{"id":"1706.03762","title":"Attention Is All You Need","authors":"Vaswani et al."}\n' > "$home/.paper7/cache/1706.03762/meta.json"
printf '# Attention Is All You Need\n\nBody...\n' > "$home/.paper7/cache/1706.03762/paper.md"

mkdir -p "$home/.paper7/cache/pmid-38903003"
printf '{"id":"pmid:38903003","title":"Hypertensive Emergency","authors":"Barnett et al.","url":"https://pubmed.ncbi.nlm.nih.gov/38903003/"}\n' > "$home/.paper7/cache/pmid-38903003/meta.json"
printf '# Hypertensive Emergency\n\nClinical body...\n' > "$home/.paper7/cache/pmid-38903003/paper.md"

for cmd in fzf glow jq; do
  printf '#!/bin/sh\necho DO-NOT-INVOKE-%s\nexit 99\n' "$cmd" > "$shim_dir/$cmd"
  chmod +x "$shim_dir/$cmd"
done

browse_path="$shim_dir:$PATH"

selected=$(printf '2\n' | HOME="$home" PATH="$browse_path" $PAPER7 browse 2>&1)
if [[ "$selected" == *"DO-NOT-INVOKE"* ]]; then
  fail "browse avoids external commands" "$selected"
elif [[ "$selected" == *"1. [1706.03762] Attention Is All You Need"* && "$selected" == *"2. [pmid:38903003] Hypertensive Emergency"* && "$selected" == *"# Hypertensive Emergency"* && "$selected" == *"Clinical body"* ]]; then
  pass "browse selects and prints cached paper via stdin/stdout"
else
  fail "browse selected output mismatch" "$selected"
fi

cancelled=$(printf 'q\n' | HOME="$home" PATH="$browse_path" $PAPER7 browse 2>&1)
if [[ "$cancelled" == *"Browse cancelled"* ]]; then
  pass "browse handles cancelled selection"
else
  fail "cancel output mismatch" "$cancelled"
fi

eof=$(HOME="$home" PATH="$browse_path" $PAPER7 browse </dev/null 2>&1)
if [[ "$eof" == *"Browse cancelled"* ]]; then
  pass "browse handles input EOF as cancellation"
else
  fail "EOF output mismatch" "$eof"
fi

set +e
invalid=$(printf '9\n' | HOME="$home" PATH="$browse_path" $PAPER7 browse 2>&1)
invalid_code=$?
set -e
if [[ "$invalid_code" -ne 0 && "$invalid" == *"invalid selection"* ]]; then
  pass "browse rejects invalid input clearly"
else
  fail "invalid input mismatch" "code=$invalid_code output=$invalid"
fi

empty_home=$(mktemp -d)
empty=$(HOME="$empty_home" PATH="$browse_path" $PAPER7 browse </dev/null 2>&1)
rm -rf "$empty_home"
if [[ "$empty" == "No papers cached" ]]; then
  pass "browse handles empty cache"
else
  fail "empty cache mismatch" "$empty"
fi

missing_home=$(mktemp -d)
mkdir -p "$missing_home/.paper7/cache/2401.04088"
printf '{"id":"2401.04088","title":"Missing Markdown"}\n' > "$missing_home/.paper7/cache/2401.04088/meta.json"
set +e
missing=$(printf '1\n' | HOME="$missing_home" PATH="$browse_path" $PAPER7 browse 2>&1)
missing_code=$?
set -e
rm -rf "$missing_home"
if [[ "$missing_code" -ne 0 && "$missing" == *"no cached paper for 2401.04088"* ]]; then
  pass "browse reports missing selected cache entry"
else
  fail "missing cache entry mismatch" "code=$missing_code output=$missing"
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
