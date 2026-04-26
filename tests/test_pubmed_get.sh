#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
PUBMED_FIXTURE="$ROOT/tests/fixtures/pubmed_get.xml"
PMID="38903003"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

tmp_home() { mktemp -d; }

home=$(tmp_home)
output=$(HOME="$home" PAPER7_PUBMED_GET_FIXTURE="$PUBMED_FIXTURE" $PAPER7 get "pmid:${PMID}" --no-tldr 2>&1)
cache=$(<"$home/.paper7/cache/pmid-${PMID}/paper.md")
meta=$(<"$home/.paper7/cache/pmid-${PMID}/meta.json")
if [[ "$output" == *'<untrusted-content source="pubmed" id="pmid:38903003">'* && "$output" == *"# Fixture PubMed Paper"* && "$output" == *"## Abstract"* && "$output" == *"**Background.** PubMed fixture abstract first sentence."* && "$cache" != *"untrusted-content"* && "$meta" == *'"id":"pmid:38903003"'* && "$meta" == *'"title":"Fixture PubMed Paper"'* && "$meta" == *'"authors":"Lovelace A, Hopper G"'* ]]; then
  pass "pmid get fetches fixture markdown and canonical cache"
else
  fail "pmid get output/cache unexpected: $output meta=$meta"
fi

url_output=$(HOME="$home" $PAPER7 get "https://pubmed.ncbi.nlm.nih.gov/${PMID}/" --no-tldr 2>&1)
if [[ "$url_output" == "$output" ]]; then
  pass "PubMed URL resolves to same cached paper"
else
  fail "PubMed URL output differed"
fi

if [[ -f "$home/.paper7/cache/pmid-${PMID}/paper.md" && "$cache" != *$'\n\n\n'* ]]; then
  pass "PubMed cache uses pmid layout and unwrapped markdown"
else
  fail "PubMed cache layout/canonical markdown unexpected"
fi
rm -rf "$home"

retry_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makePubmedClient } from "./dist/pubmed.js"
  let calls = 0
  const xml = `<PubmedArticleSet><PubmedArticle><ArticleTitle>Title</ArticleTitle><Author><LastName>Last</LastName><Initials>A</Initials></Author><PubDate><Year>2024</Year></PubDate><AbstractText>Abstract.</AbstractText></PubmedArticle></PubmedArticleSet>`
  const client = makePubmedClient({
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? new Response("busy", { status: 500 }) : new Response(xml, { status: 200 })
    },
    timeoutMs: 1000,
    retries: 1,
    retryDelay: 0
  })
  await Effect.runPromise(client.get("38903003"))
  console.log(calls)
')
if [[ "$retry_output" == "2" ]]; then
  pass "PubMed get client retries bounded transient failures"
else
  fail "PubMed get retry expected 2 calls, got $retry_output"
fi

output=$($PAPER7 get pmid:abc123 2>&1) && code=0 || code=$?
if [[ $code -ne 0 && "$output" == *"error: invalid PubMed ID: pmid:abc123"* ]]; then
  pass "invalid PMID rejected before network"
else
  fail "invalid PMID expected deterministic error, got code=$code output=$output"
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
