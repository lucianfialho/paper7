#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
PAPERS_FIXTURE="$ROOT/tests/fixtures/pwc_papers.json"
EMPTY_PAPERS_FIXTURE="$ROOT/tests/fixtures/pwc_papers_empty.json"
REPOS_FIXTURE="$ROOT/tests/fixtures/pwc_repos.json"
PARTIAL_REPOS_FIXTURE="$ROOT/tests/fixtures/pwc_repos_partial.json"
BAD_SHAPE_FIXTURE="$ROOT/tests/fixtures/pwc_bad_shape.json"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

output=$(PAPER7_PWC_PAPERS_FIXTURE="$PAPERS_FIXTURE" PAPER7_PWC_REPOS_FIXTURE="$REPOS_FIXTURE" $PAPER7 repo 1706.03762 2>&1)
if [[ "$output" == *"Found 1 repository candidate:"* && "$output" == *"[papers-with-code official] fixture-repo"* && "$output" == *"https://github.com/example/fixture-repo"* ]]; then
  pass "repo renders fixture repository"
else
  fail "repo fixture output unexpected: $output"
fi

missing_output=$(PAPER7_PWC_PAPERS_FIXTURE="$EMPTY_PAPERS_FIXTURE" $PAPER7 repo 1706.03762 2>&1)
if [[ "$missing_output" == "No repositories found" ]]; then
  pass "repo labels no repository found"
else
  fail "no repo expected clear label, got $missing_output"
fi

malformed_output=$(PAPER7_PWC_PAPERS_FIXTURE="$BAD_SHAPE_FIXTURE" $PAPER7 repo 1706.03762 2>&1) && code=0 || code=$?
if [[ $code -ne 0 && "$malformed_output" == *"error: Papers With Code decode failure: Papers With Code paper response missing results"* ]]; then
  pass "repo malformed upstream response fails safely"
else
  fail "malformed response expected decode error, got code=$code output=$malformed_output"
fi

partial_output=$(PAPER7_PWC_PAPERS_FIXTURE="$PAPERS_FIXTURE" PAPER7_PWC_REPOS_FIXTURE="$PARTIAL_REPOS_FIXTURE" $PAPER7 repo doi:10.1000/example 2>&1)
if [[ "$partial_output" == *"Papers With Code partial failure: skipped malformed repository"* && "$partial_output" == *"https://github.com/example/recovered-repo"* ]]; then
  pass "repo labels partial repository failures"
else
  fail "partial repository failure label missing: $partial_output"
fi

timeout_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeRepositoryDiscoveryClient } from "./dist/repo.js"
  const client = makeRepositoryDiscoveryClient({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    }),
    timeoutMs: 5,
    retries: 0
  })
  const result = await Effect.runPromiseExit(client.discover({ tag: "arxiv", id: "1706.03762" }))
  console.log(result._tag === "Failure" && result.cause.toString().includes("PapersWithCodeTimeoutError") ? "ok" : result._tag)
')
if [[ "$timeout_output" == "ok" ]]; then
  pass "repo client timeout is bounded and typed"
else
  fail "timeout expected typed error, got $timeout_output"
fi

retry_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeRepositoryDiscoveryClient } from "./dist/repo.js"
  let calls = 0
  const papers = JSON.stringify({ results: [{ id: "fixture-paper" }] })
  const repos = JSON.stringify({ results: [] })
  const client = makeRepositoryDiscoveryClient({
    fetchImpl: async (url) => {
      calls += 1
      if (calls === 1) return new Response("busy", { status: 500 })
      return new Response(url.includes("/repositories/") ? repos : papers, { status: 200 })
    },
    retries: 1,
    retryDelay: 0
  })
  await Effect.runPromise(client.discover({ tag: "arxiv", id: "1706.03762" }))
  console.log(calls)
')
if [[ "$retry_output" == "3" ]]; then
  pass "repo client retries transient failures boundedly"
else
  fail "retry expected 3 calls, got $retry_output"
fi

transient_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeRepositoryDiscoveryClient } from "./dist/repo.js"
  let calls = 0
  const client = makeRepositoryDiscoveryClient({
    fetchImpl: async () => {
      calls += 1
      return new Response("busy", { status: 500 })
    },
    retries: 1,
    retryDelay: 0
  })
  const result = await Effect.runPromiseExit(client.discover({ tag: "pubmed", id: "38903003" }))
  const typed = result._tag === "Failure" && result.cause.toString().includes("PapersWithCodeTransientError")
  console.log(typed && calls === 2 ? "ok" : `${result._tag}:${calls}`)
')
if [[ "$transient_output" == "ok" ]]; then
  pass "repo client bounded transient failure is typed"
else
  fail "transient failure expected typed error after 2 calls, got $transient_output"
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
