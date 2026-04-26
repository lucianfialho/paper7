#!/usr/bin/env bash
set -euo pipefail

PAPER7="${PAPER7:-node dist/cli.js}"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

check_parse() {
  local name="$1"
  local expected="$2"
  shift 2
  local output
  output=$(node --input-type=module -e '
    import { parseCliArgs } from "./dist/parser.js"
    const result = parseCliArgs(process.argv.slice(1))
    console.log(result.ok ? JSON.stringify(result.command) : `ERROR:${result.error}`)
  ' -- "$@")
  if [[ "$output" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name: expected $expected, got $output"
  fi
}

check_parse_contains() {
  local name="$1"
  local expected="$2"
  shift 2
  local output
  output=$(node --input-type=module -e '
    import { parseCliArgs } from "./dist/parser.js"
    const result = parseCliArgs(process.argv.slice(1))
    console.log(result.ok ? JSON.stringify(result.command) : `ERROR:${result.error}`)
  ' -- "$@")
  if [[ "$output" == *"$expected"* ]]; then
    pass "$name"
  else
    fail "$name: expected $expected, got $output"
  fi
}

check_error() {
  local name="$1"
  shift
  local output
  output=$(node --input-type=module -e '
    import { parseCliArgs } from "./dist/parser.js"
    const result = parseCliArgs(process.argv.slice(1))
    console.log(result.ok ? JSON.stringify(result.command) : `ERROR:${result.error}`)
  ' -- "$@")
  if [[ "$output" == ERROR:* ]]; then
    pass "$name"
  else
    fail "$name: expected parse error, got $output"
  fi
}

check_parse "search parses source/max" '{"tag":"search","query":"attention","source":"pubmed","max":3}' search attention --source pubmed --max 3
check_parse "get parses arxiv id/options/range" '{"tag":"get","id":{"tag":"arxiv","id":"2401.04088"},"detailed":true,"range":{"start":35,"end":67},"refs":false,"cache":false,"tldr":false}' get 2401.04088 --detailed --range 35:67 --no-refs --no-cache --no-tldr
check_parse_contains "get parses arxiv url" '"tag":"arxiv","id":"2401.04088"' get https://arxiv.org/abs/2401.04088v2
check_parse_contains "get parses arxiv pdf url" '"tag":"arxiv","id":"2401.04088"' get https://arxiv.org/pdf/2401.04088.pdf
check_parse_contains "get parses ar5iv url" '"tag":"arxiv","id":"2401.04088"' get https://ar5iv.labs.arxiv.org/html/2401.04088
check_parse_contains "get parses pubmed prefix" '"tag":"pubmed","id":"38903003"' get pmid:38903003
check_parse_contains "get parses pubmed url" '"tag":"pubmed","id":"38903003"' get https://pubmed.ncbi.nlm.nih.gov/38903003/
check_parse_contains "get parses doi" '"tag":"doi","id":"10.1101/2023.12.15.571821"' get doi:10.1101/2023.12.15.571821
check_parse "refs parses json/max" '{"tag":"refs","id":{"tag":"arxiv","id":"1706.03762"},"max":2,"json":true}' refs 1706.03762 --max 2 --json
check_parse "repo parses id" '{"tag":"repo","id":{"tag":"arxiv","id":"2401.04088"}}' repo 2401.04088
check_parse "list parses" '{"tag":"list"}' list
check_parse "cache clear parses all" '{"tag":"cache-clear"}' cache clear
check_parse "cache clear parses id" '{"tag":"cache-clear","id":{"tag":"pubmed","id":"38903003"}}' cache clear pmid:38903003
check_parse "vault init parses path" '{"tag":"vault-init","path":"/tmp/vault"}' vault init /tmp/vault
check_parse "vault export parses id" '{"tag":"vault-export","id":{"tag":"arxiv","id":"2401.04088"}}' vault 2401.04088
check_parse "vault all parses" '{"tag":"vault-all"}' vault all
check_parse "browse parses" '{"tag":"browse"}' browse
check_parse "help parses" '{"tag":"help"}' help
check_parse "--help parses" '{"tag":"help"}' --help
check_parse "-h parses" '{"tag":"help"}' -h
check_parse "--version parses" '{"tag":"version"}' --version
check_parse "-v parses" '{"tag":"version"}' -v

check_error "invalid command rejected" nope
check_error "invalid source rejected" search x --source bogus
check_error "invalid max rejected" search x --max 0
check_error "missing query rejected" search --source pubmed
check_error "invalid id rejected" get not-an-id
check_error "invalid pmid rejected" get pmid:abc
check_error "invalid doi rejected" get doi:abc
check_error "invalid range rejected" get 2401.04088 --detailed --range 67:35
check_error "missing range value rejected" get 2401.04088 --detailed --range
check_error "malformed range rejected" get 2401.04088 --detailed --range 1:two
check_error "range requires detailed" get 2401.04088 --range 35:67
check_error "unknown option rejected" refs 1706.03762 --bogus
check_error "extra arg rejected" browse extra
check_error "cache without clear rejected" cache
check_error "cache wrong subcommand rejected" cache purge
check_error "cache extra arg rejected" cache clear 2401.04088 extra
check_error "vault missing action rejected" vault
check_error "vault init missing path rejected" vault init
check_error "vault all extra arg rejected" vault all extra
check_error "repo extra arg rejected" repo 2401.04088 extra
check_error "list extra arg rejected" list extra

output=$($PAPER7 get nope 2>&1) && code=0 || code=$?
if [[ $code -ne 0 && "$output" == *"error: invalid paper id: nope"* ]]; then
  pass "invalid CLI id exits non-zero with deterministic error"
else
  fail "invalid CLI id: expected non-zero deterministic error, got code=$code output=$output"
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
