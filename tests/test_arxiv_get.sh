#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
ARXIV_FIXTURE="$ROOT/tests/fixtures/arxiv_get.xml"
AR5IV_FIXTURE="$ROOT/tests/fixtures/ar5iv_get.html"
BAD_AR5IV_FIXTURE="$ROOT/tests/fixtures/ar5iv_bad_shape.html"
S2_TLDR_FIXTURE="$ROOT/tests/fixtures/s2_tldr.json"
S2_REFS_FIXTURE="$ROOT/tests/fixtures/s2_refs.json"
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

home=$(tmp_home)
output=$(HOME="$home" PAPER7_ARXIV_FIXTURE="$ARXIV_FIXTURE" PAPER7_AR5IV_FIXTURE="$AR5IV_FIXTURE" PAPER7_S2_FIXTURE="$S2_TLDR_FIXTURE" $PAPER7 get 2401.04088 --no-cache 2>&1)
cache=$(<"$home/.paper7/cache/2401.04088/paper.md")
rm -rf "$home"
if [[ "$output" == *"**TLDR:** Fixture TLDR from Semantic Scholar."* && "$cache" == *"**TLDR:** Fixture TLDR from Semantic Scholar."* ]]; then
  pass "get enriches canonical markdown with fixture TLDR"
else
  fail "TLDR fixture missing from output/cache: $output"
fi

home=$(tmp_home)
output=$(HOME="$home" PAPER7_ARXIV_FIXTURE="$ARXIV_FIXTURE" PAPER7_AR5IV_FIXTURE="$AR5IV_FIXTURE" PAPER7_S2_FIXTURE="$ROOT/tests/fixtures/missing-s2.json" $PAPER7 get 2401.04088 --no-cache --no-tldr 2>&1)
cache=$(<"$home/.paper7/cache/2401.04088/paper.md")
rm -rf "$home"
if [[ "$output" != *"**TLDR:**"* && "$cache" != *"**TLDR:**"* && "$output" == *"Fresh fixture body"* ]]; then
  pass "--no-tldr skips Semantic Scholar enrichment"
else
  fail "--no-tldr leaked TLDR or failed fetch: $output"
fi

home=$(tmp_home)
mkdir -p "$home/.paper7/cache/2401.04088"
cat > "$home/.paper7/cache/2401.04088/paper.md" <<'MD'
# Golden Paper

**Authors:** Test Author
**arXiv:** https://arxiv.org/abs/2401.04088
**TLDR:** Cached TLDR.

---

Golden abstract first sentence.

## Introduction
Intro 1.
Intro 2.
Intro 3.
Intro 4.
Intro 5.
Intro 6.
Intro 7.
Intro 8.
Intro 9.
Intro 10.

## Method
Method 1.
Method 2.
Method 3.
Method 4.
Method 5.
Method 6.
Method 7.
Method 8.
Method 9.
Method 10.

## References
Reference 1.
Reference 2.
MD
compact=$(HOME="$home" $PAPER7 get 2401.04088 2>&1)
detailed=$(HOME="$home" $PAPER7 get 2401.04088 --detailed 2>&1)
ranged=$(HOME="$home" $PAPER7 get 2401.04088 --detailed --range 11:13 2>&1)
no_refs=$(HOME="$home" $PAPER7 get 2401.04088 --detailed --no-refs 2>&1)
no_tldr=$(HOME="$home" $PAPER7 get 2401.04088 --detailed --no-tldr 2>&1)
bash_ranged=$(HOME="$home" "$ROOT/paper7.sh" get 2401.04088 --detailed --range 11:13 2>&1)
rm -rf "$home"
if [[ "$compact" == *"**Summary:** Golden abstract first sentence."* && "$compact" == *"| Introduction | 11-22 |"* && "$compact" == *"paper7 get 2401.04088 --detailed --range START:END"* ]]; then
  pass "compact get golden includes summary and line index"
else
  fail "compact golden mismatch: $compact"
fi
if [[ "$detailed" == *"<untrusted-content source=\"arxiv\" id=\"2401.04088\">"* && "$detailed" == *"## References"* && "$detailed" == *"Reference 2."* ]]; then
  pass "--detailed get golden returns full wrapped paper"
else
  fail "detailed golden mismatch: $detailed"
fi
if [[ "$ranged" == *"# Golden Paper (lines 11-13)"* && "$ranged" == *"## Introduction"* && "$ranged" != *"Intro 3."* ]]; then
  pass "--range get golden returns requested slice"
else
  fail "range golden mismatch: $ranged"
fi
if [[ "$no_refs" != *"## References"* && "$no_refs" != *"Reference 1."* && "$no_refs" == *"## Method"* ]]; then
  pass "--no-refs get golden omits references"
else
  fail "no-refs golden mismatch: $no_refs"
fi
if [[ "$no_tldr" != *"**TLDR:**"* && "$no_tldr" == *"Golden abstract first sentence."* ]]; then
  pass "--no-tldr get golden strips cached TLDR"
else
  fail "no-tldr golden mismatch: $no_tldr"
fi
refs_json=$(PAPER7_S2_REFS_FIXTURE="$S2_REFS_FIXTURE" $PAPER7 refs 1706.03762 --json 2>&1)
if node -e 'JSON.parse(process.argv[1])' "$refs_json" && [[ "$refs_json" == \{* && "$refs_json" == *'"data"'* && "$refs_json" != *"untrusted-content"* ]]; then
  pass "refs --json emits raw valid JSON without trust wrapper"
else
  fail "refs json mismatch: $refs_json"
fi
if [[ "$ranged" == *"$bash_ranged"* ]]; then
  pass "TS get range output preserves Bash range contract"
else
  fail "TS/Bash range parity mismatch: ts=$ranged bash=$bash_ranged"
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
