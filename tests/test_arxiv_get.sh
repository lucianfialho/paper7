#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
ARXIV_FIXTURE="$ROOT/tests/fixtures/arxiv_get.xml"
AR5IV_FIXTURE="$ROOT/tests/fixtures/ar5iv_get.html"
BAD_AR5IV_FIXTURE="$ROOT/tests/fixtures/ar5iv_bad_shape.html"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

tmp_home() { mktemp -d; }

home=$(tmp_home)
mkdir -p "$home/.paper7/cache/2401.04088"
cat > "$home/.paper7/cache/2401.04088/paper.md" <<'MD'
# Cached Fixture

**Authors:** Cache Author
**arXiv:** https://arxiv.org/abs/2401.04088

---

Cached body.
MD
output=$(HOME="$home" $PAPER7 get 2401.04088 2>&1)
cache=$(<"$home/.paper7/cache/2401.04088/paper.md")
rm -rf "$home"
if [[ "$output" == *'<untrusted-content source="arxiv" id="2401.04088">'* && "$output" == *"Cached body."* && "$cache" != *"untrusted-content"* ]]; then
  pass "cache hit wraps stdout without mutating canonical cache"
else
  fail "cache hit output/cache unexpected: $output"
fi

home=$(tmp_home)
output=$(HOME="$home" PAPER7_ARXIV_FIXTURE="$ARXIV_FIXTURE" PAPER7_AR5IV_FIXTURE="$AR5IV_FIXTURE" $PAPER7 get 2401.04088 2>&1)
cache=$(<"$home/.paper7/cache/2401.04088/paper.md")
rm -rf "$home"
if [[ "$output" == *"# Fixture Get Paper"* && "$output" == *"## Introduction"* && "$output" == *"Fresh fixture body with **bold** text."* && "$cache" == *"Fresh fixture body"* && "$cache" != *"untrusted-content"* ]]; then
  pass "cache miss fetches arXiv/ar5iv and stores unwrapped markdown"
else
  fail "cache miss output/cache unexpected: $output"
fi

home=$(tmp_home)
id_output=$(HOME="$home" PAPER7_ARXIV_FIXTURE="$ARXIV_FIXTURE" PAPER7_AR5IV_FIXTURE="$AR5IV_FIXTURE" $PAPER7 get 2401.04088 2>&1)
url_output=$(HOME="$home" $PAPER7 get https://arxiv.org/abs/2401.04088v2 2>&1)
rm -rf "$home"
if [[ "$id_output" == "$url_output" ]]; then
  pass "arXiv URL uses same canonical cache as ID"
else
  fail "URL output differed from ID output"
fi

home=$(tmp_home)
mkdir -p "$home/.paper7/cache/2401.04088"
printf '# Stale\n\nstale-cache\n' > "$home/.paper7/cache/2401.04088/paper.md"
output=$(HOME="$home" PAPER7_ARXIV_FIXTURE="$ARXIV_FIXTURE" PAPER7_AR5IV_FIXTURE="$AR5IV_FIXTURE" $PAPER7 get 2401.04088 --no-cache 2>&1)
cache=$(<"$home/.paper7/cache/2401.04088/paper.md")
rm -rf "$home"
if [[ "$output" == *"Fresh fixture body"* && "$cache" == *"Fresh fixture body"* && "$output" != *"stale-cache"* ]]; then
  pass "--no-cache bypasses stale cache and refreshes it"
else
  fail "--no-cache did not refresh stale cache: $output"
fi

output=$($PAPER7 get not-an-id 2>&1) && code=0 || code=$?
if [[ $code -ne 0 && "$output" == *"error: invalid paper id: not-an-id"* ]]; then
  pass "invalid ID fails before network"
else
  fail "invalid ID expected deterministic error, got code=$code output=$output"
fi

retry_output=$(node --input-type=module -e '
  import { Effect } from "effect"
  import { makeAr5ivClient } from "./dist/ar5iv.js"
  let calls = 0
  const html = `<article><p>ok</p></article>`
  const client = makeAr5ivClient({
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? new Response("busy", { status: 500 }) : new Response(html, { status: 200 })
    },
    timeoutMs: 1000,
    retries: 1,
    retryDelay: 0
  })
  await Effect.runPromise(client.getHtml("2401.04088"))
  console.log(calls)
')
if [[ "$retry_output" == "2" ]]; then
  pass "ar5iv client retries bounded transient failures"
else
  fail "ar5iv retry expected 2 calls, got $retry_output"
fi

home=$(tmp_home)
output=$(HOME="$home" PAPER7_ARXIV_FIXTURE="$ARXIV_FIXTURE" PAPER7_AR5IV_FIXTURE="$BAD_AR5IV_FIXTURE" $PAPER7 get 2401.04088 2>&1) && code=0 || code=$?
rm -rf "$home"
if [[ $code -ne 0 && "$output" == *"error: ar5iv decode failure: ar5iv response missing article"* ]]; then
  pass "ar5iv unexpected response shape fails safely"
else
  fail "ar5iv bad shape expected decode failure, got code=$code output=$output"
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
