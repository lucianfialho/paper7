#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
ARXIV_FIXTURE="$ROOT/tests/fixtures/arxiv_get.xml"
AR5IV_FIXTURE="$ROOT/tests/fixtures/ar5iv_get.html"
PUBMED_FIXTURE="$ROOT/tests/fixtures/pubmed_get.xml"
CROSSREF_FIXTURE="$ROOT/tests/fixtures/crossref_get.json"
PMID="38903003"
DOI="10.1101/2023.12.15.571821"
DOI_DIR="doi-10.1101_2023.12.15.571821"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

tmp_home() { mktemp -d; }

home=$(tmp_home)
empty=$(HOME="$home" $PAPER7 list 2>&1)
if [[ "$empty" == "No cached papers" ]]; then
  pass "list handles empty cache"
else
  fail "empty list mismatch: $empty"
fi

HOME="$home" PAPER7_ARXIV_FIXTURE="$ARXIV_FIXTURE" PAPER7_AR5IV_FIXTURE="$AR5IV_FIXTURE" $PAPER7 get 2401.04088 --no-tldr >/dev/null 2>&1
HOME="$home" PAPER7_PUBMED_GET_FIXTURE="$PUBMED_FIXTURE" $PAPER7 get "pmid:${PMID}" --no-tldr >/dev/null 2>&1
HOME="$home" PAPER7_CROSSREF_FIXTURE="$CROSSREF_FIXTURE" $PAPER7 get "doi:${DOI}" --no-tldr >/dev/null 2>&1

list=$(HOME="$home" $PAPER7 list 2>&1)
if [[ "$list" == *"Cached papers (3):"* && "$list" == *"[2401.04088] Fixture Get Paper"* && "$list" == *"[pmid:38903003] Fixture PubMed Paper"* && "$list" == *"[doi:10.1101/2023.12.15.571821] Fixture DOI Paper"* ]]; then
  pass "list reads arxiv pubmed doi cache"
else
  fail "list missing cached papers: $list"
fi

if [[ -f "$home/.paper7/cache/2401.04088/paper.md" && -f "$home/.paper7/cache/pmid-${PMID}/meta.json" && -f "$home/.paper7/cache/${DOI_DIR}/meta.json" ]]; then
  pass "get writes compatible cache layouts"
else
  fail "cache writes missing expected files"
fi

single=$(HOME="$home" $PAPER7 cache clear "pmid:${PMID}" 2>&1)
after_single=$(HOME="$home" $PAPER7 list 2>&1)
if [[ "$single" == "Cleared cache for pmid:${PMID}" && ! -e "$home/.paper7/cache/pmid-${PMID}" && "$after_single" != *"pmid:${PMID}"* && "$after_single" == *"2401.04088"* ]]; then
  pass "cache clear id removes one paper"
else
  fail "single clear mismatch: single=$single list=$after_single"
fi

missing=$(HOME="$home" $PAPER7 cache clear "pmid:${PMID}" 2>&1)
if [[ "$missing" == "No cache entry for pmid:${PMID}" ]]; then
  pass "cache clear id reports missing entry"
else
  fail "missing clear mismatch: $missing"
fi

mkdir -p "$home/.paper7/cache/doi-bad"
printf '{bad json' > "$home/.paper7/cache/doi-bad/meta.json"
printf '# Bad DOI\n' > "$home/.paper7/cache/doi-bad/paper.md"
malformed=$(HOME="$home" $PAPER7 list 2>&1)
if [[ "$malformed" == *"warning: skipping malformed metadata in doi-bad"* && "$malformed" == *"warning: skipping DOI cache without readable metadata in doi-bad"* && "$malformed" == *"2401.04088"* ]]; then
  pass "list warns and skips malformed DOI metadata"
else
  fail "malformed metadata mismatch: $malformed"
fi

clear_all=$(HOME="$home" $PAPER7 cache clear 2>&1)
after_all=$(HOME="$home" $PAPER7 list 2>&1)
if [[ "$clear_all" == "Cleared paper7 cache" && ! -e "$home/.paper7/cache" && "$after_all" == "No cached papers" ]]; then
  pass "cache clear removes full cache"
else
  fail "full clear mismatch: clear=$clear_all list=$after_all"
fi

clear_empty=$(HOME="$home" $PAPER7 cache clear 2>&1)
if [[ "$clear_empty" == "No paper7 cache found" ]]; then
  pass "cache clear reports empty cache"
else
  fail "empty clear mismatch: $clear_empty"
fi

rm -rf "$home"

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
