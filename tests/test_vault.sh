#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAPER7="${PAPER7:-node $ROOT/dist/cli.js}"
FAILED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "Building..."
npm run build >/dev/null 2>&1 || { echo "Build failed"; exit 1; }

tmp_home() { mktemp -d; }

home=$(tmp_home)
vault="$home/Vault"
mkdir -p "$vault" "$home/.paper7/cache/2401.04088" "$home/.paper7/cache/pmid-38903003" "$home/.paper7/cache/doi-10.1101_2023.12.15.571821"

cat > "$home/.paper7/cache/2401.04088/meta.json" <<'JSON'
{"id":"2401.04088","title":"Fixture Get Paper","authors":"Ada Lovelace, Grace Hopper","url":"https://arxiv.org/abs/2401.04088"}
JSON
cat > "$home/.paper7/cache/2401.04088/paper.md" <<'MD'
# Fixture Get Paper

**Authors:** Ada Lovelace, Grace Hopper
**arXiv:** https://arxiv.org/abs/2401.04088

---

Body.
MD
cat > "$home/.paper7/cache/pmid-38903003/meta.json" <<'JSON'
{"id":"pmid:38903003","title":"Fixture PubMed Paper","authors":"Jane Doe","url":"https://pubmed.ncbi.nlm.nih.gov/38903003/"}
JSON
cat > "$home/.paper7/cache/pmid-38903003/paper.md" <<'MD'
# Fixture PubMed Paper

**Authors:** Jane Doe
**PubMed:** https://pubmed.ncbi.nlm.nih.gov/38903003/
MD
cat > "$home/.paper7/cache/doi-10.1101_2023.12.15.571821/meta.json" <<'JSON'
{"id":"doi:10.1101/2023.12.15.571821","title":"Unsafe / DOI: Paper","authors":"John Doe","url":"https://www.biorxiv.org/content/10.1101/2023.12.15.571821"}
JSON
cat > "$home/.paper7/cache/doi-10.1101_2023.12.15.571821/paper.md" <<'MD'
# Unsafe / DOI: Paper

**Authors:** John Doe
**DOI:** 10.1101/2023.12.15.571821
MD

init=$(HOME="$home" $PAPER7 vault init "$vault" 2>&1)
if [[ "$init" == "Configured vault: $vault" && -f "$home/.paper7/config" && "$(cat "$home/.paper7/config")" == "PAPER7_VAULT=$vault" ]]; then
  pass "vault init stores config"
else
  fail "vault init mismatch: $init"
fi

single=$(HOME="$home" $PAPER7 vault 2401.04088 2>&1)
exported="$vault/2401.04088.md"
if [[ "$single" == "Exported 2401.04088 to $exported" && -f "$exported" && "$(cat "$exported")" == *"paper7-id: 2401.04088"* && "$(cat "$exported")" == *"# Fixture Get Paper"* ]]; then
  pass "vault exports one cached paper"
else
  fail "single export mismatch: $single"
fi

bulk=$(HOME="$home" $PAPER7 vault all 2>&1)
if [[ "$bulk" == "Exported 3 papers to $vault" && -f "$vault/pmid-38903003.md" && -f "$vault/doi-10.1101_2023.12.15.571821.md" ]]; then
  pass "vault exports all cached papers"
else
  fail "bulk export mismatch: $bulk"
fi

if [[ ! -e "$vault/doi-10.1101/2023.12.15.571821.md" ]]; then
  pass "vault export filenames are path safe"
else
  fail "unsafe nested DOI path created"
fi

missing=$(HOME="$home" $PAPER7 vault 2401.99999 2>&1 || true)
if [[ "$missing" == "error: vault export failed: no cached paper for 2401.99999" ]]; then
  pass "vault reports missing cached paper"
else
  fail "missing cache mismatch: $missing"
fi

missing_config_home=$(tmp_home)
missing_config=$(HOME="$missing_config_home" $PAPER7 vault 2401.04088 2>&1 || true)
if [[ "$missing_config" == "error: vault export failed: vault not configured; run paper7 vault init <path>" ]]; then
  pass "vault reports missing config"
else
  fail "missing config mismatch: $missing_config"
fi
rm -rf "$missing_config_home"

invalid_home=$(tmp_home)
mkdir -p "$invalid_home/.paper7/cache/2401.04088"
printf 'PAPER7_VAULT=%s\n' "$invalid_home/not-a-dir" > "$invalid_home/.paper7/config"
invalid=$(HOME="$invalid_home" $PAPER7 vault 2401.04088 2>&1 || true)
if [[ "$invalid" == "error: vault export failed: invalid vault path: $invalid_home/not-a-dir" ]]; then
  pass "vault reports invalid config path"
else
  fail "invalid path mismatch: $invalid"
fi
rm -rf "$invalid_home"

empty_home=$(tmp_home)
empty=$(HOME="$empty_home" $PAPER7 vault init "" 2>&1 || true)
if [[ "$empty" == "error: vault export failed: invalid vault path: <empty>" && ! -f "$empty_home/.paper7/config" ]]; then
  pass "vault rejects empty init path"
else
  fail "empty init path mismatch: $empty"
fi
rm -rf "$empty_home"

rm -rf "$home"

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All tests passed"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit $FAILED
fi
