#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
FIXTURE="$ROOT/tests/fixtures/s2_refs.json"
PARTIAL_FIXTURE="$ROOT/tests/fixtures/s2_refs_partial.json"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

output=$(PAPER7_S2_REFS_FIXTURE="$FIXTURE" $PAPER7 refs 1706.03762 --max 1 2>&1)
if [[ "$output" == *"[arxiv:1706.03762]  Attention Is All You Need"* && "$output" == *"Vaswani, Shazeer (2017)"* ]]; then
  pass "refs renders fixture references"
else
  fail "refs fixture output unexpected: $output"
fi

json_output=$(PAPER7_S2_REFS_FIXTURE="$FIXTURE" $PAPER7 refs 1706.03762 --max 1 --json 2>&1)
json_check=$(JSON_OUTPUT="$json_output" node --input-type=module -e '
  const parsed = JSON.parse(process.env.JSON_OUTPUT ?? "")
  console.log(Array.isArray(parsed.data) && parsed.data[0]?.id === "arxiv:1706.03762" && Array.isArray(parsed.warnings) ? "ok" : "bad")
')
if [[ "$json_check" == "ok" ]]; then
  pass "refs --json emits valid machine-readable JSON"
else
  fail "refs --json invalid: $json_output"
fi

partial_output=$(PAPER7_S2_REFS_FIXTURE="$PARTIAL_FIXTURE" $PAPER7 refs 1706.03762 --max 2 2>&1)
if [[ "$partial_output" == *"Semantic Scholar partial failure: skipped malformed reference"* && "$partial_output" == *"[doi:10.1000/test]  Enriched Reference"* ]]; then
  pass "refs labels partial enrichment failures"
else
  fail "refs partial failure label missing: $partial_output"
fi

missing_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeSemanticScholarClient } from "./dist/semanticScholar.js"
  const client = makeSemanticScholarClient({
    fetchImpl: async () => new Response("missing", { status: 404 }),
    retries: 0
  })
  const result = await Effect.runPromiseExit(client.references({ id: { tag: "arxiv", id: "9999.99999" }, max: 1 }))
  console.log(result._tag === "Failure" && result.cause.toString().includes("SemanticScholarNotFoundError") ? "ok" : result._tag)
')
if [[ "$missing_output" == "ok" ]]; then
  pass "Semantic Scholar missing paper is typed"
else
  fail "missing paper expected typed not found error, got $missing_output"
fi

rate_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeSemanticScholarClient } from "./dist/semanticScholar.js"
  const client = makeSemanticScholarClient({
    fetchImpl: async () => new Response("limited", { status: 429, headers: { "retry-after": "30" } }),
    retries: 1,
    retryDelay: 0
  })
  const result = await Effect.runPromiseExit(client.references({ id: { tag: "arxiv", id: "1706.03762" }, max: 1 }))
  console.log(result._tag === "Failure" && result.cause.toString().includes("SemanticScholarRateLimitError") ? "ok" : result._tag)
')
if [[ "$rate_output" == "ok" ]]; then
  pass "Semantic Scholar rate limit is typed"
else
  fail "rate limit expected typed error, got $rate_output"
fi

timeout_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeSemanticScholarClient } from "./dist/semanticScholar.js"
  const client = makeSemanticScholarClient({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    }),
    timeoutMs: 5,
    retries: 0
  })
  const result = await Effect.runPromiseExit(client.references({ id: { tag: "arxiv", id: "1706.03762" }, max: 1 }))
  console.log(result._tag === "Failure" && result.cause.toString().includes("SemanticScholarTimeoutError") ? "ok" : result._tag)
')
if [[ "$timeout_output" == "ok" ]]; then
  pass "Semantic Scholar timeout is bounded and typed"
else
  fail "timeout expected typed error, got $timeout_output"
fi

retry_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeSemanticScholarClient } from "./dist/semanticScholar.js"
  let calls = 0
  const client = makeSemanticScholarClient({
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? new Response("busy", { status: 500 }) : new Response(JSON.stringify({ data: [] }), { status: 200 })
    },
    retries: 1,
    retryDelay: 0
  })
  await Effect.runPromise(client.references({ id: { tag: "arxiv", id: "1706.03762" }, max: 1 }))
  console.log(calls)
')
if [[ "$retry_output" == "2" ]]; then
  pass "Semantic Scholar retries transient failures boundedly"
else
  fail "retry expected 2 calls, got $retry_output"
fi

transient_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeSemanticScholarClient } from "./dist/semanticScholar.js"
  let calls = 0
  const client = makeSemanticScholarClient({
    fetchImpl: async () => {
      calls += 1
      return new Response("busy", { status: 500 })
    },
    retries: 1,
    retryDelay: 0
  })
  const result = await Effect.runPromiseExit(client.references({ id: { tag: "arxiv", id: "1706.03762" }, max: 1 }))
  const typed = result._tag === "Failure" && result.cause.toString().includes("SemanticScholarTransientError")
  console.log(typed && calls === 2 ? "ok" : `${result._tag}:${calls}`)
')
if [[ "$transient_output" == "ok" ]]; then
  pass "Semantic Scholar bounded transient failure is typed"
else
  fail "transient failure expected typed error after 2 calls, got $transient_output"
fi

if [[ "${PAPER7_LIVE_S2_REFS:-}" == "1" ]]; then
  live_output=$($PAPER7 refs 1706.03762 --max 1 2>&1)
  if [[ "$live_output" == *"["* ]]; then
    pass "live Semantic Scholar refs smoke"
  else
    fail "live Semantic Scholar refs unexpected: $live_output"
  fi
else
  pass "live Semantic Scholar refs smoke skipped (set PAPER7_LIVE_S2_REFS=1)"
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
