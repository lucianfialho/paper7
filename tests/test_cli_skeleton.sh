#!/usr/bin/env bash
set -euo pipefail

# Test the npm CLI skeleton: help, version, bin execution, package metadata

PAPER7="${PAPER7:-node dist/cli.js}"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; ((FAILED++)); }

# Build first
echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

# Test --version
output=$($PAPER7 --version 2>&1)
if [[ "$output" == *"0.6.0-beta.0"* ]]; then
  pass "--version prints version"
else
  fail "--version: expected 0.6.0-beta.0, got: $output"
fi

# Test -v
output=$($PAPER7 -v 2>&1)
if [[ "$output" == *"0.6.0-beta.0"* ]]; then
  pass "-v prints version"
else
  fail "-v: expected 0.6.0-beta.0, got: $output"
fi

# Test --help
output=$($PAPER7 --help 2>&1)
if [[ "$output" == *"paper7"* && "$output" == *"Commands:"* && "$output" == *"Options:"* ]]; then
  pass "--help prints command overview"
else
  fail "--help: expected command overview, got: $output"
fi

# Test -h
output=$($PAPER7 -h 2>&1)
if [[ "$output" == *"paper7"* && "$output" == *"Commands:"* && "$output" == *"Options:"* ]]; then
  pass "-h prints command overview"
else
  fail "-h: expected command overview, got: $output"
fi

# Test help subcommand
output=$($PAPER7 help 2>&1)
if [[ "$output" == *"paper7"* && "$output" == *"Commands:"* && "$output" == *"Options:"* ]]; then
  pass "help subcommand prints command overview"
else
  fail "help: expected command overview, got: $output"
fi

# Test no args defaults to help
output=$($PAPER7 2>&1)
if [[ "$output" == *"paper7"* && "$output" == *"Commands:"* && "$output" == *"Options:"* ]]; then
  pass "no args defaults to help"
else
  fail "no args: expected command overview, got: $output"
fi

# Test package.json metadata
name=$(node -e "console.log(require('./package.json').name)")
version=$(node -e "console.log(require('./package.json').version)")
type=$(node -e "console.log(require('./package.json').type)")

if [[ "$name" == "@guataiba/paper7" ]]; then
  pass "package.json name is @guataiba/paper7"
else
  fail "package.json name: expected @guataiba/paper7, got: $name"
fi

if [[ "$version" == "0.6.0-beta.0" ]]; then
  pass "package.json version is 0.6.0-beta.0"
else
  fail "package.json version: expected 0.6.0-beta.0, got: $version"
fi

if [[ "$type" == "module" ]]; then
  pass "package.json type is module"
else
  fail "package.json type: expected module, got: $type"
fi

# Test no postinstall
if node -e "const p = require('./package.json'); process.exit(p.scripts && p.scripts.postinstall ? 1 : 0)" 2>&1; then
  pass "package.json has no postinstall script"
else
  fail "package.json should not have postinstall script"
fi

# Test bin points to dist/
bin=$(node -e "console.log(require('./package.json').bin.paper7)")
if [[ "$bin" == dist/* ]]; then
  pass "bin points to dist/"
else
  fail "bin: expected dist/*, got: $bin"
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
