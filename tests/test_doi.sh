#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
CROSSREF_FIXTURE="$ROOT/tests/fixtures/crossref_get.json"
TEST_DOI="10.1101/2023.12.15.571821"
TEST_DIR_SUFFIX="10.1101_2023.12.15.571821"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

tmp_home() { mktemp -d; }

home=$(tmp_home)
output=$(HOME="$home" PAPER7_CROSSREF_FIXTURE="$CROSSREF_FIXTURE" $PAPER7 get "doi:${TEST_DOI}" --no-tldr 2>&1)
cache=$(<"$home/.paper7/cache/doi-${TEST_DIR_SUFFIX}/paper.md")
meta=$(<"$home/.paper7/cache/doi-${TEST_DIR_SUFFIX}/meta.json")
if [[ "$output" == *'<untrusted-content source="doi" id="doi:10.1101/2023.12.15.571821">'* && "$output" == *"# Fixture DOI Paper"* && "$output" == *"**DOI:** ${TEST_DOI}"* && "$output" == *"**Full text:** https://www.biorxiv.org/content/10.1101/2023.12.15.571821.full"* && "$output" == *"## Abstract"* && "$output" == *"DOI fixture abstract first sentence."* && "$cache" != *"untrusted-content"* && "$meta" == *'"id":"doi:10.1101/2023.12.15.571821"'* && "$meta" == *'"title":"Fixture DOI Paper"'* && "$meta" == *'"authors":"Ada Lovelace, Grace Hopper"'* ]]; then
  pass "DOI get fetches fixture markdown and canonical cache"
else
  fail "DOI get output/cache unexpected: $output meta=$meta"
fi

cached=$(HOME="$home" $PAPER7 get "doi:${TEST_DOI}" --no-tldr 2>&1)
if [[ "$cached" == "$output" ]]; then
  pass "DOI cache hit is deterministic"
else
  fail "DOI cache hit differed"
fi

if [[ -f "$home/.paper7/cache/doi-${TEST_DIR_SUFFIX}/paper.md" && "$cache" != *$'\n\n\n'* ]]; then
  pass "DOI cache directory is filesystem safe and markdown canonical"
else
  fail "DOI cache layout/canonical markdown unexpected"
fi
rm -rf "$home"

retry_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeCrossrefClient } from "./dist/crossref.js"
  let calls = 0
  const json = JSON.stringify({ message: { DOI: "10.1000/x", title: ["Title"], author: [{ given: "A", family: "B" }], publisher: "Pub", issued: { "date-parts": [[2024]] }, URL: "https://doi.org/10.1000/x", abstract: "Abstract." } })
  const client = makeCrossrefClient({
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? new Response("busy", { status: 500 }) : new Response(json, { status: 200 })
    },
    timeoutMs: 1000,
    retries: 1,
    retryDelay: 0
  })
  await Effect.runPromise(client.get("10.1000/x"))
  console.log(calls)
')
if [[ "$retry_output" == "2" ]]; then
  pass "Crossref client retries bounded transient failures"
else
  fail "Crossref retry expected 2 calls, got $retry_output"
fi

output=$($PAPER7 get doi:not-a-doi 2>&1) && code=0 || code=$?
if [[ $code -ne 0 && "$output" == *"error: invalid DOI: doi:not-a-doi"* ]]; then
  pass "invalid DOI rejected before network"
else
  fail "invalid DOI expected deterministic error, got code=$code output=$output"
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
