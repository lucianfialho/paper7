#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
SEARCH_FIXTURE="$ROOT/tests/fixtures/pubmed_search.json"
SUMMARY_FIXTURE="$ROOT/tests/fixtures/pubmed_summary.json"
BAD_SEARCH_FIXTURE="$ROOT/tests/fixtures/pubmed_bad_search.json"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

output=$(PAPER7_PUBMED_SEARCH_FIXTURE="$SEARCH_FIXTURE" PAPER7_PUBMED_SUMMARY_FIXTURE="$SUMMARY_FIXTURE" $PAPER7 search covid --source pubmed --max 2 2>&1)
if [[ "$output" == *"Found 42 papers (showing 2):"* && "$output" == *"[pmid:38903003] Test PubMed Search Paper"* && "$output" == *"Ada Lovelace, Grace Hopper (2024)"* && "$output" == *"[pmid:38600001] Another PubMed Result"* ]]; then
  pass "PubMed fixture search renders literature results"
else
  fail "PubMed fixture search output unexpected: $output"
fi

output=$(PAPER7_PUBMED_SEARCH_FIXTURE="$BAD_SEARCH_FIXTURE" PAPER7_PUBMED_SUMMARY_FIXTURE="$SUMMARY_FIXTURE" $PAPER7 search covid --source pubmed 2>&1) && code=0 || code=$?
if [[ $code -ne 0 && "$output" == *"error: PubMed decode failure: PubMed search response missing count or idlist"* ]]; then
  pass "PubMed unexpected search shape fails safely"
else
  fail "PubMed bad shape expected decode failure, got code=$code output=$output"
fi

url_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makePubmedClient } from "./dist/pubmed.js"
  const captured = []
  const search = JSON.stringify({ esearchresult: { count: "1", idlist: ["38903003"] } })
  const summary = JSON.stringify({ result: { "38903003": { title: "Title", pubdate: "2024", authors: [] } } })
  const client = makePubmedClient({
    fetchImpl: async (url) => {
      captured.push(url)
      return new Response(captured.length === 1 ? search : summary, { status: 200 })
    },
    timeoutMs: 1000,
    retries: 0
  })
  await Effect.runPromise(client.search({ query: "heart failure", max: 7, sort: "date" }))
  console.log(captured.join("\n"))
')
if [[ "$url_output" == *"retmax=7"* && "$url_output" == *"sort=pub+date"* && "$url_output" == *"term=heart+failure"* && "$url_output" == *"id=38903003"* ]]; then
  pass "PubMed client maps max/sort/query/id to API URLs"
else
  fail "PubMed API URL wrong: $url_output"
fi

retry_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makePubmedClient } from "./dist/pubmed.js"
  let calls = 0
  const search = JSON.stringify({ esearchresult: { count: "0", idlist: [] } })
  const client = makePubmedClient({
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? new Response("busy", { status: 500 }) : new Response(search, { status: 200 })
    },
    timeoutMs: 1000,
    retries: 1,
    retryDelay: 0
  })
  await Effect.runPromise(client.search({ query: "covid", max: 1, sort: "relevance" }))
  console.log(calls)
')
if [[ "$retry_output" == "2" ]]; then
  pass "PubMed client retries bounded transient failures"
else
  fail "PubMed retry expected 2 calls, got $retry_output"
fi

if [[ "${PAPER7_LIVE_PUBMED:-}" == "1" ]]; then
  live_output=$($PAPER7 search covid --source pubmed --max 1 2>&1)
  if [[ "$live_output" == *"[pmid:"* ]]; then
    pass "live PubMed smoke search"
  else
    fail "live PubMed smoke search unexpected: $live_output"
  fi
else
  pass "live PubMed smoke skipped (set PAPER7_LIVE_PUBMED=1)"
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
