#!/usr/bin/env bash
# Deterministic release-hardening checks for Issue #13.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
README="$ROOT/README.md"
SOURCES="$ROOT/docs/sources.md"
SKILL="$ROOT/skills/paper7/SKILL.md"
RESEARCH_SKILL="$ROOT/skills/paper7-research/SKILL.md"
PACKAGE="$ROOT/package.json"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[0;31m✗\033[0m %s\n    %s\n" "$1" "$2"; }

echo "Test 1: unsafe installer removed"
if [ -e "$ROOT/install.sh" ]; then
  fail "install.sh deleted" "install.sh must not ship on the npm branch"
elif grep -R "install\.sh" "$README" "$ROOT/claude-code" "$ROOT/docs" "$ROOT/skills" --include='*.md' >/dev/null; then
  fail "install.sh docs removed" "Markdown docs must not reference the deleted installer"
else
  pass "install.sh deleted and undocumented"
fi

echo "Test 2: README install uses npm/npx only"
install_block=$(awk '/^## Install/,/^## AI Agent Skill/' "$README")
if ! echo "$install_block" | grep -q 'npm install'; then
  fail "npm install documented" "README Install section must include npm install"
elif ! echo "$install_block" | grep -q 'npx @guataiba/paper7'; then
  fail "npx documented" "README Install section must include npx usage"
elif echo "$install_block" | grep -Eq 'curl|install\.sh|\| bash'; then
  fail "curl installer absent" "README Install section must not document curl/bash installer paths"
else
  pass "README Install section uses npm/npx only"
fi

echo "Test 3: skill docs trust boundary and source support"
skill_docs=$(printf '%s\n%s\n' "$(cat "$SKILL")" "$(cat "$RESEARCH_SKILL")")
if ! echo "$skill_docs" | grep -qi 'untrusted external data'; then
  fail "untrusted data warning" "skill docs must mark fetched paper content untrusted"
elif ! echo "$skill_docs" | grep -q 'arXiv' || ! echo "$skill_docs" | grep -q 'PubMed' || ! echo "$skill_docs" | grep -q 'DOI'; then
  fail "supported sources" "skill docs must list arXiv, PubMed, and DOI support"
else
  pass "skill docs state trust boundary and sources"
fi

echo "Test 4: source docs cover operational constraints"
if ! grep -qi 'upstream assumptions' "$SOURCES"; then
  fail "upstream assumptions" "docs/sources.md must describe upstream assumptions"
elif ! grep -qi 'timeout' "$SOURCES" || ! grep -qi 'retry' "$SOURCES"; then
  fail "timeout/retry" "docs/sources.md must describe timeout and retry behavior"
elif ! grep -qi 'polite-pool email' "$SOURCES"; then
  fail "Crossref polite-pool email" "docs/sources.md must require maintainer-owned Crossref email before publish"
else
  pass "source docs cover assumptions, timeout, retry, Crossref email"
fi

echo "Test 5: package publish surface is prebuilt and install-free"
package_check=$(node --input-type=module -e '
  import fs from "node:fs"
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  const scripts = pkg.scripts ?? {}
  const runtimeDeps = Object.keys(pkg.dependencies ?? {}).sort()
  const files = pkg.files ?? []
  const ok =
    pkg.main === "dist/cli.js" &&
    pkg.bin?.paper7 === "dist/cli.js" &&
    files.length === 1 && files[0] === "dist/" &&
    scripts.install === undefined &&
    scripts.postinstall === undefined &&
    JSON.stringify(runtimeDeps) === JSON.stringify(["@effect/platform-node", "effect"])
  process.stdout.write(ok ? "ok" : "bad")
' "$PACKAGE")
if [ "$package_check" = "ok" ]; then
  pass "package publishes dist only with small runtime deps and no install hook"
else
  fail "package publish surface" "expected dist-only package, Effect runtime deps only, and no install/postinstall"
fi

TOTAL=$((PASS + FAIL))
echo ""
echo "────────────────────────────────────────"
echo "  ${PASS}/${TOTAL} passed"
if [ "$FAIL" -gt 0 ]; then
  printf "  \033[0;31m%d failed\033[0m\n" "$FAIL"
  exit "$FAIL"
fi
exit 0
