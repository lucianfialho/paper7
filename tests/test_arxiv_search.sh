#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
FIXTURE="$ROOT/tests/fixtures/arxiv_search.xml"
BAD_FIXTURE="$ROOT/tests/fixtures/arxiv_bad_shape.xml"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

output=$(PAPER7_ARXIV_FIXTURE="$FIXTURE" $PAPER7 search attention --max 2 2>&1)
if [[ "$output" == *"Found 42 papers (showing 2):"* && "$output" == *"[2401.04088] Test & Search Paper"* && "$output" == *"Ada Lovelace, Grace Hopper (2024-01-08)"* && "$output" == *"[2312.00001] Another Result"* ]]; then
  pass "arXiv fixture search renders results"
else
  fail "arXiv fixture search output unexpected: $output"
fi

if [[ "$output" == *"arXiv partial failure: skipped malformed result"* ]]; then
  pass "arXiv malformed entries are labeled"
else
  fail "arXiv partial failure label missing: $output"
fi

output=$(PAPER7_ARXIV_FIXTURE="$BAD_FIXTURE" $PAPER7 search attention 2>&1) && code=0 || code=$?
if [[ $code -ne 0 && "$output" == *"error: arXiv decode failure: arXiv response missing totalResults"* ]]; then
  pass "arXiv unexpected response shape fails safely"
else
  fail "arXiv bad shape expected decode failure, got code=$code output=$output"
fi

url_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeArxivClient } from "./dist/arxiv.js"
  let captured = ""
  const fixture = `<?xml version="1.0"?><feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults></feed>`
  const client = makeArxivClient({
    fetchImpl: async (url) => {
      captured = url
      return new Response(fixture, { status: 200 })
    },
    timeoutMs: 1000,
    retries: 0
  })
  await Effect.runPromise(client.search({ query: "graph neural", max: 7, sort: "date" }))
  console.log(captured)
')
if [[ "$url_output" == *"max_results=7"* && "$url_output" == *"sortBy=submittedDate"* && "$url_output" == *"search_query=all%3Agraph+neural"* ]]; then
  pass "arXiv client maps max/sort/query to API URL"
else
  fail "arXiv API URL wrong: $url_output"
fi

retry_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeArxivClient } from "./dist/arxiv.js"
  let calls = 0
  const fixture = `<?xml version="1.0"?><feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults></feed>`
  const client = makeArxivClient({
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? new Response("busy", { status: 500 }) : new Response(fixture, { status: 200 })
    },
    timeoutMs: 1000,
    retries: 1,
    retryDelay: 0
  })
  await Effect.runPromise(client.search({ query: "attention", max: 1, sort: "relevance" }))
  console.log(calls)
')
if [[ "$retry_output" == "2" ]]; then
  pass "arXiv client retries bounded transient failures"
else
  fail "arXiv retry expected 2 calls, got $retry_output"
fi

if [[ "${PAPER7_LIVE_ARXIV:-}" == "1" ]]; then
  live_output=$($PAPER7 search attention --max 1 2>&1)
  if [[ "$live_output" == *"["* ]]; then
    pass "live arXiv smoke search"
  else
    fail "live arXiv smoke search unexpected: $live_output"
  fi
else
  pass "live arXiv smoke skipped (set PAPER7_LIVE_ARXIV=1)"
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
