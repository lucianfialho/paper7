#!/usr/bin/env bash
set -euo pipefail

VERSION="0.4.0"
CACHE_DIR="${HOME}/.paper7/cache"
AR5IV_URL="https://ar5iv.labs.arxiv.org/html"
ARXIV_API="http://export.arxiv.org/api/query"
PUBMED_ESEARCH="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
PUBMED_ESUMMARY="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
PUBMED_EFETCH="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
PUBMED_ARTICLE_URL="https://pubmed.ncbi.nlm.nih.gov"
SEMANTIC_SCHOLAR_API="https://api.semanticscholar.org/graph/v1"
CROSSREF_API="https://api.crossref.org/works"
CROSSREF_MAILTO="paper7@example.com"
BIORXIV_HTML_URL="https://www.biorxiv.org/content"
MEDRXIV_HTML_URL="https://www.medrxiv.org/content"

# Colors (disabled when not a TTY)
if [ -t 1 ]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
else
  BOLD='' DIM='' GREEN='' YELLOW='' RED='' CYAN='' RESET=''
fi

# --- Helpers ---

err() { echo -e "${RED}error:${RESET} $*" >&2; }
info() { [ -t 2 ] && echo -e "${DIM}$*${RESET}" >&2 || true; }

usage() {
  cat <<EOF
${BOLD}paper7${RESET} — arXiv papers as clean context for LLMs

${BOLD}Usage:${RESET}
  paper7 <command> [options]

${BOLD}Commands:${RESET}
  search <query>       Search papers by keyword (arXiv default; --source pubmed)
  get <id>             Fetch paper; compact header by default, full text with --detailed
                       id shapes: arXiv (YYMM.NNNNN), pmid:NNN, doi:10.XXXX/...
  refs <id>            List references of a paper via Semantic Scholar (requires jq)
  repo <id>            Find GitHub repositories for a paper
  list                 List cached papers in your KB
  cache clear [id]     Clear cache (all or specific paper)
  vault init <path>    Configure Obsidian-compatible vault path
  vault <id>           Export paper to vault as Obsidian-ready Markdown
  vault all            Export all cached papers to vault
  browse               Interactive picker over the local cache (requires fzf)
  kb <sub>            Knowledge base: add papers and search them (requires qmd)
  help                 Show this help

${BOLD}Options:${RESET}
  --help, -h           Show help
  --version, -v        Show version

${BOLD}Examples:${RESET}
  paper7 search "mixture of experts"
  paper7 search "psilocybin hypertension" --source pubmed --max 5
  paper7 get 2401.04088
  paper7 get 2401.04088 --detailed
  paper7 get 2401.04088 --detailed --range 35:67
  paper7 get 2401.04088 --no-refs
  paper7 get https://arxiv.org/abs/2401.04088
  paper7 repo 2401.04088
  paper7 list
  paper7 vault init ~/Documents/ArxivVault
  paper7 vault 2401.04088
  paper7 vault all
EOF
}

parse_arxiv_id() {
  local input="$1"
  local id=""

  # Strip URL prefixes
  id="${input#https://arxiv.org/abs/}"
  id="${id#http://arxiv.org/abs/}"
  id="${id#https://ar5iv.labs.arxiv.org/html/}"
  id="${id#http://ar5iv.labs.arxiv.org/html/}"

  # Remove version suffix (v1, v2, etc)
  id="${id%v[0-9]*}"

  # Validate format: YYMM.NNNNN or YYMM.NNNN
  if [[ "$id" =~ ^[0-9]{4}\.[0-9]{4,5}$ ]]; then
    echo "$id"
    return 0
  fi

  err "invalid arXiv ID: $input (expected format: YYMM.NNNNN)"
  return 1
}

parse_pmid() {
  local input="$1"
  local id=""

  # Strip accepted prefixes
  id="${input#pmid:}"
  id="${id#https://pubmed.ncbi.nlm.nih.gov/}"
  id="${id#http://pubmed.ncbi.nlm.nih.gov/}"
  id="${id%/}"

  # Validate: digits only, non-empty
  if [[ "$id" =~ ^[0-9]+$ ]]; then
    echo "$id"
    return 0
  fi

  err "invalid PubMed ID: $input (expected format: pmid:NNNNN)"
  return 1
}

is_pmid_input() {
  # Returns 0 (true) if input looks like a PubMed reference, non-zero otherwise.
  local input="$1"
  [[ "$input" == pmid:* ]] && return 0
  [[ "$input" == *pubmed.ncbi.nlm.nih.gov* ]] && return 0
  return 1
}

# Returns 0 if input looks like a DOI reference (must start with "doi:" prefix).
is_doi_input() {
  local input="$1"
  [[ "$input" == doi:* ]] && return 0
  return 1
}

# Validates and canonicalizes a DOI. Strips "doi:" prefix.
parse_doi() {
  local input="$1"
  local id="${input#doi:}"
  if [[ "$id" =~ ^10\.[0-9]{4,9}/.+$ ]]; then
    echo "$id"
    return 0
  fi
  err "invalid DOI: $input (expected format: doi:10.XXXX/...)"
  return 1
}

# Convert canonical DOI to filesystem-safe directory suffix.
doi_to_dir_suffix() {
  local doi="$1"
  echo "${doi//\//_}"
}

ensure_cache_dir() {
  mkdir -p "$CACHE_DIR"
}

load_config() {
  local config_file="${HOME}/.paper7/config"
  PAPER7_VAULT=""
  [ -f "$config_file" ] || return 0
  PAPER7_VAULT=$(grep '^PAPER7_VAULT=' "$config_file" 2>/dev/null | head -1 | cut -d= -f2- || true)
}

parse_range_spec() {
  local input="$1"
  if [[ "$input" =~ ^([0-9]+):([0-9]+)$ ]]; then
    local start="${BASH_REMATCH[1]}"
    local end="${BASH_REMATCH[2]}"
    if [ "$start" -ge 1 ] && [ "$start" -le "$end" ]; then
      echo "${start}:${end}"
      return 0
    fi
  fi

  err "invalid range: $input (expected format: START:END, START >= 1)"
  return 1
}

normalize_summary() {
  local text="$1"
  text=$(printf '%s' "$text" | tr '\n' ' ' | tr -s ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [ -z "$text" ]; then
    return 0
  fi

  if [ "${#text}" -gt 600 ]; then
    printf '%s...\n' "${text:0:597}"
  else
    printf '%s\n' "$text"
  fi
}

extract_lead_paragraph() {
  awk '
    BEGIN { after_rule = 0; seen = 0; text = "" }
    /^---$/ { after_rule = 1; next }
    !after_rule { next }
    /^###[[:space:]]+/ {
      if (seen) exit
      next
    }
    /^##[[:space:]]+/ {
      if (seen) exit
      next
    }
    /^#[[:space:]]+/ {
      if (seen) exit
      next
    }
    /^[[:space:]]*$/ {
      if (seen) exit
      next
    }
    {
      if (text != "") text = text " "
      text = text $0
      seen = 1
    }
    END { print text }
  ' "$1"
}

load_summary() {
  local dir="$1"
  local cache_file="$2"
  local summary_file="${dir}/summary.txt"

  if [ -s "$summary_file" ]; then
    cat "$summary_file"
    return 0
  fi

  normalize_summary "$(extract_lead_paragraph "$cache_file")"
}

build_output_view() {
  local cache_file="$1"
  local no_refs="$2"
  local view_file="$3"

  if [ "$no_refs" = true ]; then
    sed '/^## References/,$d' "$cache_file" > "$view_file"
  else
    cp "$cache_file" "$view_file"
  fi
}

generate_index_rows() {
  awk '
    function flush(end_line) {
      if (count == 0) return
      gsub(/\|/, "\\|", titles[count])
      printf "| %s | %d-%d |\n", titles[count], starts[count], end_line
    }
    /^###[[:space:]]+/ {
      flush(NR - 1)
      count++
      titles[count] = substr($0, 5)
      starts[count] = NR
      next
    }
    /^##[[:space:]]+/ {
      flush(NR - 1)
      count++
      titles[count] = substr($0, 4)
      starts[count] = NR
      next
    }
    /^#[[:space:]]+/ {
      if (NR == 1) next
      flush(NR - 1)
      count++
      titles[count] = substr($0, 3)
      starts[count] = NR
      next
    }
    END {
      if (NR > 0) flush(NR)
    }
  ' "$1"
}

render_detailed_range() {
  local view_file="$1"
  local title="$2"
  local range_spec="$3"
  local start="${range_spec%%:*}"
  local end="${range_spec##*:}"
  local total_lines
  total_lines=$(wc -l < "$view_file" | awk '{print $1}')

  if [ "$start" -gt "$total_lines" ]; then
    err "range start ${start} exceeds total lines ${total_lines}"
    return 1
  fi

  if [ "$end" -gt "$total_lines" ]; then
    end="$total_lines"
  fi

  echo "# ${title} (lines ${start}-${end})"
  echo ""
  echo "**Range:** ${start}-${end} of ${total_lines}"
  echo ""
  sed -n "${start},${end}p" "$view_file"
}

render_compact_output() {
  local view_file="$1"
  local dir="$2"
  local canonical_id="$3"
  local total_lines
  total_lines=$(wc -l < "$view_file" | awk '{print $1}')

  if [ "$total_lines" -lt 30 ]; then
    cat "$view_file"
    return 0
  fi

  local index_rows
  index_rows=$(generate_index_rows "$view_file")
  if [ -z "$index_rows" ]; then
    info "no section headers found; emitting full paper"
    cat "$view_file"
    return 0
  fi

  local summary
  summary=$(load_summary "$dir" "$view_file")

  local title
  title=$(sed -n '1{s/^# //;p;}' "$view_file")
  [ -z "$title" ] && title="Untitled"

  echo "# ${title}"
  echo ""
  awk '
    NR == 1 { next }
    $0 == "---" { exit }
    /^[[:space:]]*$/ { next }
    /^\*\*TLDR:\*\*/ { next }
    { print }
  ' "$view_file"

  if [ -n "$summary" ]; then
    echo ""
    echo "**Summary:** ${summary}"
  fi

  echo ""
  echo "**Index:**"
  echo "| Section | Lines |"
  echo "|---------|-------|"
  printf '%s\n' "$index_rows"
  echo ""
  echo "> Fetch lines: \`paper7 get ${canonical_id} --detailed --range START:END\`"
  echo "> Full paper: \`paper7 get ${canonical_id} --detailed\`"
}

emit_paper_output() {
  local cache_file="$1"
  local dir="$2"
  local canonical_id="$3"
  local no_refs="$4"
  local detailed="$5"
  local range_spec="$6"

  local view_file
  view_file=$(mktemp)
  build_output_view "$cache_file" "$no_refs" "$view_file"

  if [ "$detailed" = true ]; then
    if [ -n "$range_spec" ]; then
      local title
      title=$(sed -n '1{s/^# //;p;}' "$view_file")
      render_detailed_range "$view_file" "$title" "$range_spec"
      local rc=$?
      rm -f "$view_file"
      return $rc
    fi

    cat "$view_file"
    rm -f "$view_file"
    return 0
  fi

  render_compact_output "$view_file" "$dir" "$canonical_id"
  local rc=$?
  rm -f "$view_file"
  return $rc
}

# --- Semantic Scholar helpers ---

# Hard-fail when jq is missing for commands that require structured JSON parsing.
s2_check_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    err "jq not installed — install with: brew install jq (macOS) or apt install jq (debian/ubuntu)"
    return 1
  fi
}

# Map a paper7 canonical id to Semantic Scholar's externalId URL form.
# Examples:
#   1706.03762            -> arXiv:1706.03762
#   pmid:38903003         -> PMID:38903003
#   10.48550/arXiv.X      -> DOI:10.48550/arXiv.X    (heuristic: contains /)
#   <40-char hex paperId> -> passthrough
s2_paper_id_param() {
  local input="$1"
  # PubMed
  if [[ "$input" == pmid:* ]]; then
    echo "PMID:${input#pmid:}"
    return 0
  fi
  # arXiv (YYMM.NNNNN, with optional version stripped)
  if [[ "$input" =~ ^[0-9]{4}\.[0-9]{4,5}(v[0-9]+)?$ ]]; then
    local stripped="${input%v[0-9]*}"
    echo "arXiv:${stripped}"
    return 0
  fi
  # arXiv URL
  if [[ "$input" == *arxiv.org/abs/* ]]; then
    local id
    id=$(parse_arxiv_id "$input") || return 1
    echo "arXiv:${id}"
    return 0
  fi
  # DOI heuristic — contains "/"
  if [[ "$input" == *"/"* ]]; then
    echo "DOI:${input}"
    return 0
  fi
  # S2 paperId passthrough (40-char hex)
  if [[ "$input" =~ ^[0-9a-f]{40}$ ]]; then
    echo "$input"
    return 0
  fi
  # Last resort: pass as-is and let S2 reject if invalid
  echo "$input"
  return 0
}

# Best-effort TLDR fetch. Echoes the TLDR string on stdout, empty on any failure.
# Never errors out — caller treats empty string as "no TLDR available".
fetch_tldr() {
  local canonical_id="$1"
  command -v jq >/dev/null 2>&1 || return 0
  local s2_id
  s2_id=$(s2_paper_id_param "$canonical_id") || return 0
  local response
  response=$(curl -sfL "${SEMANTIC_SCHOLAR_API}/paper/${s2_id}?fields=tldr&tool=paper7" 2>/dev/null) || return 0
  [ -z "$response" ] && return 0
  printf '%s' "$response" | jq -r '.tldr.text // ""' 2>/dev/null || true
}

# --- Commands ---

cmd_get() {
  local no_cache=false
  local no_refs=false
  local no_tldr=false
  local detailed=false
  local range_spec=""
  local input=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-cache) no_cache=true; shift ;;
      --no-refs)  no_refs=true; shift ;;
      --no-tldr)  no_tldr=true; shift ;;
      --detailed) detailed=true; shift ;;
      --range)
        if [ $# -lt 2 ]; then
          err "missing value for --range"
          return 1
        fi
        range_spec=$(parse_range_spec "$2") || return 1
        shift 2
        ;;
      --help|-h)
        cat <<EOF
Usage: paper7 get <id> [--no-refs] [--no-cache] [--no-tldr] [--detailed] [--range START:END]

IDs:
  arXiv   — e.g. 2401.04088 or https://arxiv.org/abs/2401.04088
  PubMed  — e.g. pmid:38903003

Options:
  --no-refs     Strip References section (arXiv only; no-op for PubMed)
  --no-cache    Force re-download, bypassing local cache
  --no-tldr     Skip the Semantic Scholar TLDR enrichment lookup
  --detailed    Print the full paper instead of the compact indexed header
  --range       Detailed-only line slice, format: START:END
EOF
        return 0
        ;;
      -*) err "unknown flag: $1"; return 1 ;;
      *)  input="$1"; shift ;;
    esac
  done

  if [ -z "$input" ]; then
    err "missing paper ID. Usage: paper7 get <id>"
    return 1
  fi

  if [ -n "$range_spec" ] && [ "$detailed" = false ]; then
    err "--range requires --detailed"
    return 1
  fi

  # Dispatch by input shape — check DOI first (more specific prefix),
  # then PMID, then fall through to arXiv.
  if is_doi_input "$input"; then
    local doi
    doi=$(parse_doi "$input") || return 1
    if [ "$no_refs" = true ]; then
      info "note: --no-refs has no effect for DOI fetches"
    fi
    cmd_get_doi "$doi" "$no_cache" "$no_tldr" "$detailed" "$range_spec"
    return $?
  fi

  if is_pmid_input "$input"; then
    local pmid
    pmid=$(parse_pmid "$input") || return 1
    if [ "$no_refs" = true ]; then
      info "note: --no-refs has no effect for PubMed abstracts"
    fi
    cmd_get_pubmed "$pmid" "$no_cache" "$no_tldr" "$detailed" "$range_spec"
    return $?
  fi

  local id
  id=$(parse_arxiv_id "$input") || return 1
  cmd_get_arxiv "$id" "$no_cache" "$no_refs" "$no_tldr" "$detailed" "$range_spec"
}

cmd_get_arxiv() {
  local id="$1"
  local no_cache="$2"
  local no_refs="$3"
  local no_tldr="${4:-false}"
  local detailed="${5:-false}"
  local range_spec="${6:-}"

  local dir="${CACHE_DIR}/${id}"
  local cache_file="${dir}/paper.md"
  local meta_file="${dir}/meta.json"

  # Check cache
  if [ "$no_cache" = false ] && [ -f "$cache_file" ]; then
    info "cached: $cache_file"
    emit_paper_output "$cache_file" "$dir" "$id" "$no_refs" "$detailed" "$range_spec"
    return 0
  fi

  ensure_cache_dir
  mkdir -p "$dir"

  local html_file="${dir}/raw.html"

  # Fetch metadata from arXiv API (clean title + authors)
  info "fetching metadata for $id ..."
  local api_file="${dir}/api.xml"
  curl -sL -o "$api_file" "https://export.arxiv.org/api/query?id_list=${id}&max_results=1"

  local title
  title=$(sed -n 's/.*<title>\(.*\)<\/title>.*/\1/p' "$api_file" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//' || true)
  [ -z "$title" ] && title="Unknown Title"

  local authors
  authors=$(sed -n 's/.*<name>\(.*\)<\/name>.*/\1/p' "$api_file" 2>/dev/null | tr '\n' ',' | sed 's/,$//' | sed 's/,/, /g' || true)
  [ -z "$authors" ] && authors="Unknown Authors"

  local abstract
  abstract=$(tr '\n' ' ' < "$api_file" | sed -n 's:.*<summary>\(.*\)</summary>.*:\1:p' | tail -1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)

  rm -f "$api_file"

  # Fetch full text from ar5iv
  info "fetching ${AR5IV_URL}/${id} ..."

  local http_code
  http_code=$(curl -sL -o "$html_file" -w "%{http_code}" "${AR5IV_URL}/${id}")

  if [ "$http_code" != "200" ]; then
    rm -f "$html_file"
    if [ "$http_code" = "404" ]; then
      err "paper $id not found on ar5iv (HTTP 404)"
      err "the paper may be too recent or not yet converted to HTML"
      return 1
    fi
    err "failed to fetch paper $id (HTTP $http_code)"
    return 2
  fi

  # Best-effort TLDR enrichment from Semantic Scholar (silent on failure).
  local tldr=""
  if [ "$no_tldr" = false ]; then
    info "fetching TLDR from Semantic Scholar ..."
    tldr=$(fetch_tldr "$id" || true)
  fi

  local summary
  summary=$(normalize_summary "$abstract")
  if [ -z "$summary" ]; then
    summary=$(normalize_summary "$tldr")
  fi

  # Build markdown: header + converted content
  {
    echo "# ${title}"
    echo ""
    echo "**Authors:** ${authors}"
    echo "**arXiv:** https://arxiv.org/abs/${id}"
    [ -n "$tldr" ] && echo "**TLDR:** ${tldr}"
    echo ""
    echo "---"
    echo ""

    # Extract article, convert HTML to Markdown, clean up
    # Use awk for robust HTML-to-Markdown conversion
    sed -n '/<article/,/<\/article>/p' "$html_file" \
      | awk '
        { line = line " " $0 }
        END {
          s = line
          # Remove annotations and math tags
          gsub(/<annotation[^>]*>[^<]*<\/annotation>/, "", s)
          gsub(/<math[^>]*>/, "", s); gsub(/<\/math>/, "", s)
          # Remove section number spans
          gsub(/<span class="ltx_tag[^"]*">[^<]*<\/span>/, "", s)
          # Headers
          gsub(/<h1[^>]*>/, "\n# ", s); gsub(/<\/h1>/, "\n", s)
          gsub(/<h2[^>]*>/, "\n## ", s); gsub(/<\/h2>/, "\n", s)
          gsub(/<h3[^>]*>/, "\n### ", s); gsub(/<\/h3>/, "\n", s)
          gsub(/<h4[^>]*>/, "\n#### ", s); gsub(/<\/h4>/, "\n", s)
          gsub(/<h5[^>]*>/, "\n##### ", s); gsub(/<\/h5>/, "\n", s)
          # Paragraphs and breaks
          gsub(/<\/p>/, "\n\n", s)
          gsub(/<br[^>]*>/, "\n", s)
          # Lists
          gsub(/<li[^>]*>/, "- ", s); gsub(/<\/li>/, "\n", s)
          # Inline formatting
          gsub(/<strong[^>]*>/, "**", s); gsub(/<\/strong>/, "**", s)
          gsub(/<em[^>]*>/, "*", s); gsub(/<\/em>/, "*", s)
          gsub(/<code[^>]*>/, "`", s); gsub(/<\/code>/, "`", s)
          # Blockquotes and rules
          gsub(/<blockquote[^>]*>/, "\n> ", s); gsub(/<\/blockquote>/, "\n", s)
          gsub(/<hr[^>]*>/, "\n---\n", s)
          # Strip remaining tags
          gsub(/<[^>]*>/, "", s)
          # HTML entities
          gsub(/&amp;/, "\\&", s); gsub(/&lt;/, "<", s)
          gsub(/&gt;/, ">", s); gsub(/&quot;/, "\"", s)
          gsub(/&nbsp;/, " ", s)
          # LaTeX cleanup
          gsub(/\{\}\^{[^}]*\}/, "", s); gsub(/\{\}_{[^}]*\}/, "", s)
          # Print
          print s
        }
      ' \
      | tr -s ' ' \
      | sed 's/^ //' \
      | sed '/^$/{ N; /^\n$/d; }'
  } > "$cache_file"

  # Save metadata (TLDR included only when present, to keep meta valid otherwise)
  if [ -n "$tldr" ]; then
    cat > "$meta_file" <<META
{"id":"${id}","title":"$(echo "$title" | sed 's/"/\\"/g')","authors":"$(echo "$authors" | sed 's/"/\\"/g' | head -c 200)","tldr":"$(echo "$tldr" | sed 's/"/\\"/g' | tr -d '\n')"}
META
  else
    cat > "$meta_file" <<META
{"id":"${id}","title":"$(echo "$title" | sed 's/"/\\"/g')","authors":"$(echo "$authors" | sed 's/"/\\"/g' | head -c 200)"}
META
  fi

  # Clean up raw HTML
  rm -f "$html_file"

  if [ -n "$summary" ]; then
    printf '%s\n' "$summary" > "${dir}/summary.txt"
  fi

  info "cached: $cache_file"
  emit_paper_output "$cache_file" "$dir" "$id" "$no_refs" "$detailed" "$range_spec"
}

cmd_get_pubmed() {
  local pmid="$1"
  local no_cache="$2"
  local no_tldr="${3:-false}"
  local detailed="${4:-false}"
  local range_spec="${5:-}"

  local dir="${CACHE_DIR}/pmid-${pmid}"
  local cache_file="${dir}/paper.md"
  local meta_file="${dir}/meta.json"

  # Check cache
  if [ "$no_cache" = false ] && [ -f "$cache_file" ]; then
    info "cached: $cache_file"
    emit_paper_output "$cache_file" "$dir" "pmid:${pmid}" false "$detailed" "$range_spec"
    return 0
  fi

  ensure_cache_dir
  mkdir -p "$dir"

  local xml_file="${dir}/efetch.xml"
  local url="${PUBMED_EFETCH}?db=pubmed&id=${pmid}&rettype=abstract&retmode=xml&tool=paper7"

  info "fetching PubMed efetch for pmid:${pmid} ..."

  if ! curl -sfL -o "$xml_file" "$url" 2>/dev/null; then
    rm -rf "$dir"
    err "failed to reach PubMed (efetch)"
    return 2
  fi

  if [ ! -s "$xml_file" ]; then
    rm -rf "$dir"
    err "failed to reach PubMed (empty response)"
    return 2
  fi

  if ! grep -q '<PubmedArticle[ >]' "$xml_file"; then
    rm -rf "$dir"
    err "PubMed returned no article for pmid:${pmid}"
    return 2
  fi

  # Flatten XML for regex parsing (strip newlines, collapse whitespace)
  local flat
  flat=$(tr '\n' ' ' < "$xml_file" | tr -s ' ')

  # --- Title (stripping any inline tags like <sup>, <i>) ---
  # Optional extracts tolerate missing fields; each pipe ends with `|| true`.
  local title
  title=$(printf '%s' "$flat" \
    | grep -oE '<ArticleTitle[^>]*>[^<]*(<[^/][^>]*>[^<]*</[^>]+>[^<]*)*</ArticleTitle>' \
    | head -1 \
    | sed -E 's|<ArticleTitle[^>]*>||; s|</ArticleTitle>.*||' \
    | sed -E 's|<[^>]*>||g' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
  [ -z "$title" ] && title="Unknown Title"

  # --- Authors: concatenate LastName + Initials across <Author> blocks ---
  local authors
  authors=$(printf '%s' "$flat" | awk '
    BEGIN { RS="</Author>"; seen=0 }
    /<Author[ >]/ {
      last=""; init=""
      if (match($0, /<LastName>[^<]*<\/LastName>/)) {
        last = substr($0, RSTART, RLENGTH)
        sub(/<LastName>/, "", last); sub(/<\/LastName>/, "", last)
      }
      if (match($0, /<Initials>[^<]*<\/Initials>/)) {
        init = substr($0, RSTART, RLENGTH)
        sub(/<Initials>/, "", init); sub(/<\/Initials>/, "", init)
      }
      if (last != "") {
        if (seen > 0) printf ", "
        if (init != "") printf "%s %s", last, init
        else printf "%s", last
        seen++
      }
    }
  ')
  [ -z "$authors" ] && authors="Unknown Authors"

  # --- Journal title (prefer <Journal><Title>; fallback to ISOAbbreviation) ---
  local journal
  journal=$(printf '%s' "$flat" \
    | grep -oE '<Journal>.*</Journal>' | head -1 \
    | grep -oE '<Title>[^<]*</Title>' | head -1 \
    | sed -E 's|</?Title>||g' || true)
  if [ -z "$journal" ]; then
    journal=$(printf '%s' "$flat" \
      | grep -oE '<ISOAbbreviation>[^<]*</ISOAbbreviation>' | head -1 \
      | sed -E 's|</?ISOAbbreviation>||g' || true)
  fi

  # --- PubDate ---
  local pubdate_block pubyear pubmonth pubday medline_date pubdate
  pubdate_block=$(printf '%s' "$flat" | grep -oE '<PubDate>.*</PubDate>' | head -1 || true)
  pubyear=$(printf '%s' "$pubdate_block" | grep -oE '<Year>[^<]+</Year>' | head -1 | sed -E 's|</?Year>||g' || true)
  pubmonth=$(printf '%s' "$pubdate_block" | grep -oE '<Month>[^<]+</Month>' | head -1 | sed -E 's|</?Month>||g' || true)
  pubday=$(printf '%s' "$pubdate_block" | grep -oE '<Day>[^<]+</Day>' | head -1 | sed -E 's|</?Day>||g' || true)
  medline_date=$(printf '%s' "$pubdate_block" | grep -oE '<MedlineDate>[^<]+</MedlineDate>' | head -1 | sed -E 's|</?MedlineDate>||g' || true)
  if [ -n "$pubyear" ]; then
    pubdate="$pubyear"
    [ -n "$pubmonth" ] && pubdate="${pubdate} ${pubmonth}"
    [ -n "$pubday" ] && pubdate="${pubdate} ${pubday}"
  elif [ -n "$medline_date" ]; then
    pubdate="$medline_date"
  else
    pubdate="Unknown"
  fi

  # --- DOI ---
  local doi
  doi=$(printf '%s' "$flat" \
    | grep -oE '<ArticleId[^>]*IdType="doi"[^>]*>[^<]+</ArticleId>' | head -1 \
    | sed -E 's|<ArticleId[^>]*>||; s|</ArticleId>||' || true)
  if [ -z "$doi" ]; then
    doi=$(printf '%s' "$flat" \
      | grep -oE '<ELocationID[^>]*EIdType="doi"[^>]*>[^<]+</ELocationID>' | head -1 \
      | sed -E 's|<ELocationID[^>]*>||; s|</ELocationID>||' || true)
  fi

  # --- Abstract (may have multiple labeled sections) ---
  local abstract
  abstract=$(printf '%s' "$flat" | awk '
    BEGIN { RS="</AbstractText>"; ORS="" }
    /<AbstractText/ {
      if (match($0, /<AbstractText[^>]*>/)) {
        tag = substr($0, RSTART, RLENGTH)
        content = substr($0, RSTART + RLENGTH)
        label = ""
        if (match(tag, /Label="[^"]*"/)) {
          label = substr(tag, RSTART+7, RLENGTH-8)
        }
        gsub(/<[^>]*>/, "", content)
        sub(/^ +/, "", content); sub(/ +$/, "", content)
        if (content != "") {
          if (label != "") printf "**%s.** %s\n\n", label, content
          else printf "%s\n\n", content
        }
      }
    }
  ')
  [ -z "$abstract" ] && abstract="(no abstract available)"

  # --- Write Markdown ---
  # --- TLDR via Semantic Scholar (best-effort) ---
  local tldr=""
  if [ "$no_tldr" = false ]; then
    info "fetching TLDR from Semantic Scholar ..."
    tldr=$(fetch_tldr "pmid:${pmid}" || true)
  fi

  local summary
  summary=$(normalize_summary "$abstract")
  if [ -z "$summary" ]; then
    summary=$(normalize_summary "$tldr")
  fi

  {
    echo "# ${title}"
    echo ""
    echo "**Authors:** ${authors}"
    [ -n "$journal" ] && echo "**Journal:** ${journal}"
    echo "**Published:** ${pubdate}"
    [ -n "$doi" ] && echo "**DOI:** ${doi}"
    echo "**PubMed:** ${PUBMED_ARTICLE_URL}/${pmid}/"
    [ -n "$tldr" ] && echo "**TLDR:** ${tldr}"
    echo ""
    echo "---"
    echo ""
    echo "## Abstract"
    echo ""
    printf '%s\n' "$abstract" | sed 's/[[:space:]]*$//' | awk 'NF||prev{print; prev=NF} !NF{prev=0}'
  } > "$cache_file"

  # --- meta.json ---
  local url_value
  if [ -n "$doi" ]; then
    url_value="https://doi.org/${doi}"
  else
    url_value="${PUBMED_ARTICLE_URL}/${pmid}/"
  fi
  if [ -n "$tldr" ]; then
    cat > "$meta_file" <<META
{"id":"pmid:${pmid}","title":"$(printf '%s' "$title" | sed 's/"/\\"/g' | head -c 300)","authors":"$(printf '%s' "$authors" | sed 's/"/\\"/g' | head -c 200)","url":"${url_value}","tldr":"$(printf '%s' "$tldr" | sed 's/"/\\"/g' | tr -d '\n')"}
META
  else
    cat > "$meta_file" <<META
{"id":"pmid:${pmid}","title":"$(printf '%s' "$title" | sed 's/"/\\"/g' | head -c 300)","authors":"$(printf '%s' "$authors" | sed 's/"/\\"/g' | head -c 200)","url":"${url_value}"}
META
  fi

  if [ -n "$summary" ]; then
    printf '%s\n' "$summary" > "${dir}/summary.txt"
  fi

  rm -f "$xml_file"

  info "cached: $cache_file"
  emit_paper_output "$cache_file" "$dir" "pmid:${pmid}" false "$detailed" "$range_spec"
}

cmd_get_doi() {
  local doi="$1"
  local no_cache="$2"
  local no_tldr="${3:-false}"
  local detailed="${4:-false}"
  local range_spec="${5:-}"

  # Auto-redirect arXiv DOIs (10.48550/arXiv.YYMM.NNNNN) → cmd_get_arxiv,
  # so they share the existing arXiv cache and don't duplicate.
  if [[ "$doi" =~ ^10\.48550/arXiv\.([0-9]{4}\.[0-9]{4,5})$ ]]; then
    local arxiv_id="${BASH_REMATCH[1]}"
    info "DOI is arXiv mirror; redirecting to arXiv path for $arxiv_id"
    cmd_get_arxiv "$arxiv_id" "$no_cache" "false" "$no_tldr" "$detailed" "$range_spec"
    return $?
  fi

  s2_check_jq || return 1

  local dir_suffix
  dir_suffix=$(doi_to_dir_suffix "$doi")
  local dir="${CACHE_DIR}/doi-${dir_suffix}"
  local cache_file="${dir}/paper.md"
  local meta_file="${dir}/meta.json"

  # Cache hit
  if [ "$no_cache" = false ] && [ -f "$cache_file" ]; then
    info "cached: $cache_file"
    emit_paper_output "$cache_file" "$dir" "doi:${doi}" false "$detailed" "$range_spec"
    return 0
  fi

  ensure_cache_dir
  mkdir -p "$dir"

  info "fetching Crossref metadata for doi:${doi} ..."

  local tmp_response http_code
  tmp_response=$(mktemp)
  http_code=$(curl -sL -o "$tmp_response" -w "%{http_code}" \
    "${CROSSREF_API}/${doi}?mailto=${CROSSREF_MAILTO}")

  if [ "$http_code" = "404" ]; then
    rm -rf "$dir" "$tmp_response"
    err "DOI not found in Crossref: ${doi}"
    return 1
  fi
  if [ "$http_code" != "200" ]; then
    rm -rf "$dir" "$tmp_response"
    err "failed to reach Crossref (HTTP ${http_code})"
    return 2
  fi
  if [ ! -s "$tmp_response" ]; then
    rm -rf "$dir" "$tmp_response"
    err "failed to reach Crossref (empty response)"
    return 2
  fi

  # Extract fields
  local title authors source year published full_text_url abstract_raw
  title=$(jq -r '.message.title[0] // "Unknown Title"' < "$tmp_response")
  authors=$(jq -r '
    [.message.author[]? | (.given // "") + " " + (.family // "") | gsub("^ +| +$"; "")]
    | join(", ")
    | .[0:200]
  ' < "$tmp_response")
  [ -z "$authors" ] && authors="Unknown Authors"

  source=$(jq -r '
    (.message.institution[0].name // .message.publisher // "Unknown source")
  ' < "$tmp_response")

  year=$(jq -r '
    (.message.issued."date-parts"[0][0] // .message.created."date-parts"[0][0] // "Unknown") | tostring
  ' < "$tmp_response")

  published=$(jq -r '
    (.message.issued."date-parts"[0] // [])
    | if length >= 3 then
        (.[0]|tostring) + "-" + (.[1]|tostring|("00"+.) | .[-2:]) + "-" + (.[2]|tostring|("00"+.) | .[-2:])
      elif length == 2 then
        (.[0]|tostring) + "-" + (.[1]|tostring|("00"+.) | .[-2:])
      elif length == 1 then
        (.[0]|tostring)
      else "Unknown" end
  ' < "$tmp_response")

  # Full-text URL: prefer institution-specific URL when bioRxiv/medRxiv,
  # otherwise the resource URL from Crossref, otherwise doi.org redirect.
  case "$source" in
    bioRxiv) full_text_url="${BIORXIV_HTML_URL}/${doi}.full" ;;
    medRxiv) full_text_url="${MEDRXIV_HTML_URL}/${doi}.full" ;;
    *)       full_text_url=$(jq -r '
               (.message.URL // (.message.resource.primary.URL // ("https://doi.org/" + .message.DOI)))
             ' < "$tmp_response") ;;
  esac

  abstract_raw=$(jq -r '.message.abstract // ""' < "$tmp_response")

  rm -f "$tmp_response"

  # Clean JATS XML out of abstract (best-effort; falls back to placeholder).
  local abstract
  if [ -n "$abstract_raw" ]; then
    abstract=$(printf '%s' "$abstract_raw" \
      | sed -E 's|<jats:title>[^<]*</jats:title>||g' \
      | sed -E 's|<jats:p>|\n\n|g; s|</jats:p>||g' \
      | sed -E 's|<jats:[^>]+>||g; s|</jats:[^>]+>||g' \
      | sed -E 's|<[^>]+>||g' \
      | sed -E 's|&amp;|\&|g; s|&lt;|<|g; s|&gt;|>|g; s|&quot;|"|g; s|&nbsp;| |g' \
      | awk 'NF || prev { print; prev = NF } !NF { prev = 0 }' \
      | sed 's/[[:space:]]*$//')
  fi
  if [ -z "$abstract" ]; then
    abstract="(no abstract available; full text at ${full_text_url})"
  fi

  # TLDR via Semantic Scholar (best-effort)
  local tldr=""
  if [ "$no_tldr" = false ]; then
    info "fetching TLDR from Semantic Scholar ..."
    tldr=$(fetch_tldr "doi:${doi}" || true)
  fi

  local summary
  summary=$(normalize_summary "$abstract")
  if [ -z "$summary" ]; then
    summary=$(normalize_summary "$tldr")
  fi

  # Write paper.md
  {
    echo "# ${title}"
    echo ""
    echo "**Authors:** ${authors}"
    echo "**Source:** ${source}"
    echo "**Published:** ${published}"
    echo "**DOI:** ${doi}"
    echo "**Full text:** ${full_text_url}"
    [ -n "$tldr" ] && echo "**TLDR:** ${tldr}"
    echo ""
    echo "---"
    echo ""
    echo "## Abstract"
    echo ""
    printf '%s\n' "$abstract"
  } > "$cache_file"

  # Write meta.json
  if [ -n "$tldr" ]; then
    cat > "$meta_file" <<META
{"id":"doi:${doi}","title":"$(printf '%s' "$title" | sed 's/"/\\"/g' | head -c 300)","authors":"$(printf '%s' "$authors" | sed 's/"/\\"/g' | head -c 200)","url":"${full_text_url}","tldr":"$(printf '%s' "$tldr" | sed 's/"/\\"/g' | tr -d '\n')"}
META
  else
    cat > "$meta_file" <<META
{"id":"doi:${doi}","title":"$(printf '%s' "$title" | sed 's/"/\\"/g' | head -c 300)","authors":"$(printf '%s' "$authors" | sed 's/"/\\"/g' | head -c 200)","url":"${full_text_url}"}
META
  fi

  if [ -n "$summary" ]; then
    printf '%s\n' "$summary" > "${dir}/summary.txt"
  fi

  info "cached: $cache_file"
  emit_paper_output "$cache_file" "$dir" "doi:${doi}" false "$detailed" "$range_spec"
}

cmd_refs() {
  local max_results=10
  local as_json=false
  local input=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max)    max_results="$2"; shift 2 ;;
      --json)   as_json=true; shift ;;
      --help|-h)
        cat <<EOF
Usage: paper7 refs <id> [--max N] [--json]

Lists the references of a paper via Semantic Scholar.

IDs accepted:
  arXiv ID    — e.g. 1706.03762 or https://arxiv.org/abs/1706.03762
  PubMed ID   — e.g. pmid:38903003
  DOI         — e.g. 10.48550/arXiv.1706.03762
  S2 paperId  — 40-char hex string

Options:
  --max N     Max references (default: 10)
  --json      Emit raw S2 JSON (pipeable)

Requires:
  jq          for JSON parsing — https://jqlang.github.io/jq/
EOF
        return 0
        ;;
      -*) err "unknown flag: $1"; return 1 ;;
      *)  input="$1"; shift ;;
    esac
  done

  if [ -z "$input" ]; then
    err "missing paper ID. Usage: paper7 refs <id>"
    return 1
  fi

  s2_check_jq || return 1

  cmd_refs_s2 "$input" "$max_results" "$as_json"
}

cmd_refs_s2() {
  local input="$1"
  local max_results="$2"
  local as_json="$3"

  local s2_id
  s2_id=$(s2_paper_id_param "$input") || return 1

  info "fetching references from Semantic Scholar for $s2_id ..."

  local url="${SEMANTIC_SCHOLAR_API}/paper/${s2_id}/references?fields=externalIds,title,authors,year&limit=${max_results}&tool=paper7"
  local tmp_response
  tmp_response=$(mktemp)

  local http_code rc
  http_code=$(curl -sL -o "$tmp_response" -w "%{http_code}" "$url")

  if [ "$http_code" = "404" ]; then
    rm -f "$tmp_response"
    err "no paper found for ${input} on Semantic Scholar"
    return 1
  fi
  if [ "$http_code" != "200" ]; then
    rm -f "$tmp_response"
    err "failed to reach Semantic Scholar (HTTP ${http_code})"
    return 2
  fi
  if [ ! -s "$tmp_response" ]; then
    rm -f "$tmp_response"
    err "failed to reach Semantic Scholar (empty response)"
    return 2
  fi

  if [ "$as_json" = true ]; then
    cat "$tmp_response"
    rc=$?
    rm -f "$tmp_response"
    return $rc
  fi

  # Pretty print: prefer arxiv > pmid > doi > s2 paperId for the id prefix.
  jq -r --argjson max "$max_results" '
    def pick_id(ids; pid):
      if (ids.ArXiv // null)    then "arxiv:" + ids.ArXiv
      elif (ids.PubMed // null) then "pmid:" + (ids.PubMed | tostring)
      elif (ids.DOI // null)    then "doi:" + ids.DOI
      else "s2:" + (pid // "unknown")
      end;

    .data[0:$max][] | .citedPaper as $p
    | "  [" + pick_id($p.externalIds // {}; $p.paperId) + "]  "
        + ($p.title // "(no title)")
    + "\n  "
        + ([$p.authors[]?.name // empty] | map(split(" ") | last)[0:5] | join(", ") | .[0:60])
        + (if $p.year then " (" + ($p.year|tostring) + ")" else "" end)
    + "\n"
  ' < "$tmp_response"
  rc=$?
  rm -f "$tmp_response"
  return $rc
}

cmd_search() {
  local max_results=10
  local sort_by="relevance"
  local source="arxiv"
  local query=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max)    max_results="$2"; shift 2 ;;
      --sort)   sort_by="$2"; shift 2 ;;
      --source) source="$2"; shift 2 ;;
      --help|-h)
        cat <<EOF
Usage: paper7 search <query> [--source arxiv|pubmed] [--max N] [--sort relevance|date]

Options:
  --source SOURCE   Data source: arxiv (default) or pubmed
  --max N           Max results (default: 10)
  --sort KEY        relevance (default) or date

Examples:
  paper7 search "mixture of experts"
  paper7 search "psilocybin hypertension" --source pubmed --max 5
EOF
        return 0
        ;;
      -*) err "unknown flag: $1"; return 1 ;;
      *)  query="$1"; shift ;;
    esac
  done

  if [ -z "$query" ]; then
    err "missing search query. Usage: paper7 search <query>"
    return 1
  fi

  case "$source" in
    arxiv)  cmd_search_arxiv  "$query" "$max_results" "$sort_by" ;;
    pubmed) cmd_search_pubmed "$query" "$max_results" "$sort_by" ;;
    *)      err "unknown source: $source (use arxiv or pubmed)"; return 1 ;;
  esac
}

cmd_search_arxiv() {
  local query="$1"
  local max_results="$2"
  local sort_by="$3"

  local sort_param="relevance"
  [ "$sort_by" = "date" ] && sort_param="submittedDate"

  local encoded_query
  encoded_query=$(echo "$query" | sed 's/ /+/g')

  info "searching arXiv for: $query ..."

  local response
  response=$(curl -sL "${ARXIV_API}?search_query=all:${encoded_query}&start=0&max_results=${max_results}&sortBy=${sort_param}&sortOrder=descending")

  if [ -z "$response" ]; then
    err "failed to reach arXiv API"
    return 2
  fi

  # Check if we got results
  local total
  total=$(echo "$response" | grep -o '<opensearch:totalResults[^>]*>[0-9]*</opensearch:totalResults>' | grep -o '[0-9]*')
  [ -z "$total" ] && total=0

  if [ "$total" = "0" ]; then
    echo "No papers found for: $query"
    return 0
  fi

  echo -e "${BOLD}Found ${total} papers (showing ${max_results}):${RESET}"
  echo ""

  # Parse entries — extract id, title, authors, published date
  echo "$response" | awk '
    BEGIN { RS="<entry>"; FS="\n"; entry=0 }
    entry > 0 {
      id=""; title=""; authors=""; published=""
      for (i=1; i<=NF; i++) {
        if ($i ~ /<id>/) {
          gsub(/.*<id>/, "", $i)
          gsub(/<\/id>.*/, "", $i)
          id=$i
        }
        if ($i ~ /<title>/) {
          gsub(/.*<title>/, "", $i)
          gsub(/<\/title>.*/, "", $i)
          gsub(/\n/, " ", $i)
          title=$i
        }
        if ($i ~ /<name>/) {
          gsub(/.*<name>/, "", $i)
          gsub(/<\/name>.*/, "", $i)
          if (authors != "") authors = authors ", "
          authors = authors $i
        }
        if ($i ~ /<published>/) {
          gsub(/.*<published>/, "", $i)
          gsub(/<\/published>.*/, "", $i)
          published=substr($i, 1, 10)
        }
      }
      if (id != "") {
        # Extract just the ID from the URL
        gsub(/.*\/abs\//, "", id)
        gsub(/v[0-9]+$/, "", id)
        # Truncate authors if too long
        if (length(authors) > 60) authors = substr(authors, 1, 57) "..."
        # Clean title whitespace
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", title)
        gsub(/[[:space:]]+/, " ", title)
        printf "  [%s] %s\n  %s (%s)\n\n", id, title, authors, published
      }
    }
    { entry++ }
  '
}

cmd_search_pubmed() {
  local query="$1"
  local max_results="$2"
  local sort_by="$3"

  local encoded_query
  encoded_query=$(echo "$query" | sed 's/ /+/g')

  local sort_param=""
  [ "$sort_by" = "date" ] && sort_param="&sort=pub+date"

  info "searching PubMed for: $query ..."

  # Step 1: esearch → list of PubMed IDs
  local esearch_url="${PUBMED_ESEARCH}?db=pubmed&term=${encoded_query}&retmax=${max_results}${sort_param}&tool=paper7"
  local esearch_response
  esearch_response=$(curl -sfL "$esearch_url" 2>/dev/null) || {
    err "failed to reach PubMed (esearch)"
    return 2
  }

  if [ -z "$esearch_response" ]; then
    err "failed to reach PubMed (empty esearch response)"
    return 2
  fi

  local total
  total=$(echo "$esearch_response" | grep -o '<Count>[0-9]*</Count>' | head -1 | grep -o '[0-9]*')
  [ -z "$total" ] && total=0

  if [ "$total" = "0" ]; then
    echo "No papers found for: $query"
    return 0
  fi

  local ids
  ids=$(echo "$esearch_response" | grep -o '<Id>[0-9]*</Id>' | grep -o '[0-9]*' | tr '\n' ',' | sed 's/,$//')

  if [ -z "$ids" ]; then
    err "PubMed returned no IDs despite non-zero count"
    return 2
  fi

  # Step 2: esummary → metadata for each ID
  local esummary_url="${PUBMED_ESUMMARY}?db=pubmed&id=${ids}&tool=paper7"
  local esummary_response
  esummary_response=$(curl -sfL "$esummary_url" 2>/dev/null) || {
    err "failed to reach PubMed (esummary)"
    return 2
  }

  if [ -z "$esummary_response" ]; then
    err "failed to reach PubMed (empty esummary response)"
    return 2
  fi

  echo -e "${BOLD}Found ${total} papers (showing ${max_results}):${RESET}"
  echo ""

  # Parse each DocSum and emit "[pmid:NNN] title\n  authors (date)\n"
  echo "$esummary_response" | awk '
    function month_num(m,   map) {
      map["Jan"]="01"; map["Feb"]="02"; map["Mar"]="03"; map["Apr"]="04"
      map["May"]="05"; map["Jun"]="06"; map["Jul"]="07"; map["Aug"]="08"
      map["Sep"]="09"; map["Oct"]="10"; map["Nov"]="11"; map["Dec"]="12"
      return (m in map) ? map[m] : ""
    }
    function normalize_date(raw,   parts, n, mm, dd) {
      # Inputs seen: "2024 Jan 15", "2024 Jan", "2024", "2024-05-01"
      if (raw ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}/) return substr(raw, 1, 10)
      n = split(raw, parts, /[ \-\/]+/)
      if (n == 0 || parts[1] !~ /^[0-9]{4}$/) return raw
      if (n == 1) return parts[1]
      mm = month_num(parts[2])
      if (mm == "") {
        if (parts[2] ~ /^[0-9]{1,2}$/) mm = sprintf("%02d", parts[2])
        else return raw
      }
      if (n == 2) return parts[1] "-" mm
      dd = (parts[3] ~ /^[0-9]{1,2}$/) ? sprintf("%02d", parts[3]) : "01"
      return parts[1] "-" mm "-" dd
    }
    BEGIN { RS="</DocSum>"; first=1 }
    /<DocSum>/ {
      flat=$0
      gsub(/\n/, " ", flat)
      gsub(/[[:space:]]+/, " ", flat)

      pmid=""; title=""; pubdate=""; authors=""

      if (match(flat, /<Id>[0-9]+<\/Id>/)) {
        pmid = substr(flat, RSTART+4, RLENGTH-9)
      }

      if (match(flat, /<Item Name="Title"[^>]*>[^<]*<\/Item>/)) {
        tchunk = substr(flat, RSTART, RLENGTH)
        sub(/<Item Name="Title"[^>]*>/, "", tchunk)
        sub(/<\/Item>/, "", tchunk)
        title = tchunk
      }

      if (match(flat, /<Item Name="PubDate"[^>]*>[^<]*<\/Item>/)) {
        pchunk = substr(flat, RSTART, RLENGTH)
        sub(/<Item Name="PubDate"[^>]*>/, "", pchunk)
        sub(/<\/Item>/, "", pchunk)
        pubdate = normalize_date(pchunk)
      }

      tmp = flat
      while (match(tmp, /<Item Name="Author" Type="String">[^<]*<\/Item>/)) {
        achunk = substr(tmp, RSTART, RLENGTH)
        sub(/<Item Name="Author" Type="String">/, "", achunk)
        sub(/<\/Item>/, "", achunk)
        if (authors != "") authors = authors ", "
        authors = authors achunk
        tmp = substr(tmp, RSTART + RLENGTH)
      }

      if (pmid != "") {
        gsub(/^ +| +$/, "", title)
        if (length(authors) > 60) authors = substr(authors, 1, 57) "..."
        printf "  [pmid:%s] %s\n  %s (%s)\n\n", pmid, title, authors, pubdate
      }
    }
  '
}

cmd_repo() {
  local input=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) echo "Usage: paper7 repo <id>"; return 0 ;;
      -*) err "unknown flag: $1"; return 1 ;;
      *)  input="$1"; shift ;;
    esac
  done

  if [ -z "$input" ]; then
    err "missing paper ID. Usage: paper7 repo <id>"
    return 1
  fi

  local id
  id=$(parse_arxiv_id "$input") || return 1

  local html_file="${CACHE_DIR}/${id}/raw.html"

  # Try to get HTML (from cache or fetch)
  if [ ! -f "$html_file" ]; then
    info "fetching ${AR5IV_URL}/${id} ..."
    ensure_cache_dir
    mkdir -p "${CACHE_DIR}/${id}"
    curl -sL -o "$html_file" "${AR5IV_URL}/${id}"
  fi

  # Extract GitHub URLs
  local repos
  repos=$(grep -oE 'https://github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+' "$html_file" \
    | grep -v 'dginev/ar5iv' \
    | grep -v 'github\.com/topics' \
    | grep -v 'github\.com/settings' \
    | sort -u)

  if [ -z "$repos" ]; then
    echo "No GitHub repositories found for paper $id"
    return 0
  fi

  echo -e "${BOLD}Repositories for $id:${RESET}"
  echo "$repos" | while read -r repo; do
    echo "  $repo"
  done
}

cmd_list() {
  ensure_cache_dir

  local count=0
  local has_papers=false

  for dir in "${CACHE_DIR}"/*/; do
    [ -d "$dir" ] || continue
    has_papers=true

    local dir_name id
    dir_name=$(basename "$dir")
    local title="(no title)"
    local meta_file="${dir}meta.json"
    # Prefer id from meta.json (round-trip-safe — handles DOIs with _).
    # Fall back to dir-name canonicalization if meta is missing/incomplete.
    local meta_id=""
    if [ -f "$meta_file" ]; then
      meta_id=$(grep -o '"id":"[^"]*"' "$meta_file" | sed 's/"id":"//;s/"$//' | head -1 || true)
      local extracted
      extracted=$(grep -o '"title":"[^"]*"' "$meta_file" | sed 's/"title":"//;s/"$//' | head -1)
      [ -n "$extracted" ] && title="$extracted"
    fi

    if [ -n "$meta_id" ]; then
      id="$meta_id"
    elif [[ "$dir_name" == pmid-* ]]; then
      id="pmid:${dir_name#pmid-}"
    elif [[ "$dir_name" == doi-* ]]; then
      # Lossy fallback when meta.json is missing — DOIs containing literal '_'
      # would round-trip incorrectly. paper7 always writes meta.json so this
      # branch only triggers for hand-corrupted caches.
      id="doi:${dir_name#doi-}"
      id="${id//_/\/}"
    else
      id="$dir_name"
    fi

    echo -e "  ${CYAN}${id}${RESET}  ${title}"
    count=$((count + 1))
  done

  if [ "$has_papers" = false ]; then
    echo "No papers cached. Use 'paper7 get <id>' to add papers to your KB."
    return 0
  fi

  echo ""
  local size
  size=$(du -sh "$CACHE_DIR" 2>/dev/null | awk '{print $1}')
  echo -e "${DIM}${count} paper(s), ${size} total${RESET}"
}

cmd_cache() {
  local subcmd="${1:-}"
  shift 2>/dev/null || true

  case "$subcmd" in
    clear)
      local target="${1:-}"
      if [ -n "$target" ]; then
        local canonical dir_name
        if is_doi_input "$target"; then
          local doi
          doi=$(parse_doi "$target") || return 1
          canonical="doi:${doi}"
          dir_name="doi-$(doi_to_dir_suffix "$doi")"
        elif is_pmid_input "$target"; then
          local pmid
          pmid=$(parse_pmid "$target") || return 1
          canonical="pmid:${pmid}"
          dir_name="pmid-${pmid}"
        else
          canonical=$(parse_arxiv_id "$target") || return 1
          dir_name="$canonical"
        fi
        if [ -d "${CACHE_DIR}/${dir_name}" ]; then
          rm -rf "${CACHE_DIR}/${dir_name}"
          echo "Removed paper ${canonical} from cache"
        else
          err "paper ${canonical} not in cache"
          return 1
        fi
      else
        rm -rf "$CACHE_DIR"
        mkdir -p "$CACHE_DIR"
        echo "Cache cleared"
      fi
      ;;
    ""|--help|-h)
      echo "Usage: paper7 cache clear [id]"
      ;;
    *)
      err "unknown cache command: $subcmd"
      return 1
      ;;
  esac
}

cmd_vault_init() {
  local path="${1:-}"
  if [ -z "$path" ]; then
    err "missing vault path. Usage: paper7 vault init <path>"
    return 1
  fi

  # Expand leading ~
  path="${path/#\~/$HOME}"

  if [ ! -d "$path" ]; then
    info "creating vault directory: $path"
    mkdir -p "$path" || { err "failed to create vault directory: $path"; return 1; }
  fi

  mkdir -p "${HOME}/.paper7"
  local config_file="${HOME}/.paper7/config"

  if [ -f "$config_file" ]; then
    grep -v '^PAPER7_VAULT=' "$config_file" > "${config_file}.tmp" 2>/dev/null || true
    mv "${config_file}.tmp" "$config_file"
  fi
  echo "PAPER7_VAULT=${path}" >> "$config_file"

  echo "Vault path set to: $path"
}

cmd_vault_one() {
  local input="$1"
  shift || true

  local force=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) force=true; shift ;;
      -*) err "unknown flag: $1"; return 1 ;;
      *)  err "unexpected argument: $1"; return 1 ;;
    esac
  done

  load_config
  if [ -z "${PAPER7_VAULT:-}" ]; then
    err "vault not configured. Run: paper7 vault init <path>"
    return 1
  fi
  if [ ! -d "$PAPER7_VAULT" ]; then
    err "vault path missing on disk: $PAPER7_VAULT"
    return 1
  fi

  local id
  id=$(parse_arxiv_id "$input") || return 1

  local cache_md="${CACHE_DIR}/${id}/paper.md"
  local meta_file="${CACHE_DIR}/${id}/meta.json"

  # Ensure paper is cached
  if [ ! -f "$cache_md" ]; then
    info "paper $id not cached, fetching..."
    cmd_get "$id" > /dev/null || return $?
  fi

  local title authors
  title=$(grep -o '"title":"[^"]*"' "$meta_file" 2>/dev/null | sed 's/"title":"//;s/"$//' | head -1 || true)
  authors=$(grep -o '"authors":"[^"]*"' "$meta_file" 2>/dev/null | sed 's/"authors":"//;s/"$//' | head -1 || true)
  [ -z "$title" ] && title="Unknown Title"

  local vault_file="${PAPER7_VAULT}/${id}.md"

  if [ -f "$vault_file" ] && [ "$force" = false ]; then
    err "vault file already exists: $vault_file (use --force to overwrite)"
    return 1
  fi

  # YAML-escape double quotes
  local esc_title="${title//\"/\\\"}"

  # Build authors YAML list (if any)
  local authors_block=""
  if [ -n "$authors" ]; then
    authors_block="authors:"$'\n'
    IFS=',' read -ra authors_arr <<< "$authors"
    for author in "${authors_arr[@]}"; do
      # Trim whitespace
      author="${author#"${author%%[![:space:]]*}"}"
      author="${author%"${author##*[![:space:]]}"}"
      [ -z "$author" ] && continue
      local esc_author="${author//\"/\\\"}"
      authors_block+="  - \"${esc_author}\""$'\n'
    done
  fi

  {
    echo "---"
    echo "title: \"${esc_title}\""
    echo "aliases:"
    echo "  - \"${id}\""
    echo "arxiv_id: \"${id}\""
    [ -n "$authors_block" ] && printf "%s" "$authors_block"
    echo "url: \"https://arxiv.org/abs/${id}\""
    echo "tags:"
    echo "  - paper"
    echo "---"
    echo ""

    # Body: skip paper7's original header block (everything up to and including
    # the first '---' separator line), then convert arxiv references to wikilinks.
    awk '/^---$/ { found=1; next } found { print }' "$cache_md" \
      | sed -E 's|https?://arxiv\.org/abs/([0-9]{4}\.[0-9]{4,5})(v[0-9]+)?|[[\1]]|g' \
      | sed -E 's|arXiv:[[:space:]]*([0-9]{4}\.[0-9]{4,5})|[[\1]]|g' \
      | sed -E 's|abs/([0-9]{4}\.[0-9]{4,5})|[[\1]]|g'
  } > "$vault_file"

  echo "Wrote: $vault_file"
}

cmd_vault_all() {
  load_config
  if [ -z "${PAPER7_VAULT:-}" ]; then
    err "vault not configured. Run: paper7 vault init <path>"
    return 1
  fi

  ensure_cache_dir
  local count=0
  local failed=0

  for dir in "${CACHE_DIR}"/*/; do
    [ -d "$dir" ] || continue
    local id
    id=$(basename "$dir")
    if cmd_vault_one "$id" --force >/dev/null 2>&1; then
      count=$((count + 1))
    else
      failed=$((failed + 1))
      err "failed: $id"
    fi
  done

  echo "Exported ${count} paper(s) to ${PAPER7_VAULT}"
  [ "$failed" -gt 0 ] && echo "${failed} failed"
  return 0
}

cmd_vault() {
  local subcmd="${1:-}"

  case "$subcmd" in
    init)
      shift
      cmd_vault_init "$@"
      ;;
    all)
      shift
      cmd_vault_all "$@"
      ;;
    ""|--help|-h)
      cat <<EOF
Usage: paper7 vault <command>

Commands:
  init <path>    Configure vault directory (Obsidian-compatible)
  <id>           Export one paper to the vault
  all            Export all cached papers to the vault

Options:
  --force        Overwrite existing vault files

Examples:
  paper7 vault init ~/Documents/ArxivVault
  paper7 vault 2401.04088
  paper7 vault all
EOF
      ;;
    *)
      # Treat as arxiv ID
      cmd_vault_one "$@"
      ;;
  esac
}

# List cached papers as tab-separated rows for fzf piping and test assertions.
# Format: <canonical_id>\t<title>\t<cache_dir>
list_browse_entries() {
  ensure_cache_dir
  for dir in "${CACHE_DIR}"/*/; do
    [ -d "$dir" ] || continue
    local dir_name id
    dir_name=$(basename "$dir")
    if [[ "$dir_name" == pmid-* ]]; then
      id="pmid:${dir_name#pmid-}"
    else
      id="$dir_name"
    fi
    local meta_file="${dir}meta.json"
    local title="(no title)"
    if [ -f "$meta_file" ]; then
      local extracted
      extracted=$(grep -o '"title":"[^"]*"' "$meta_file" 2>/dev/null | sed 's/"title":"//;s/"$//' | head -1 || true)
      [ -n "$extracted" ] && title="$extracted"
    fi
    # Strip any literal tabs that might have landed in title, to keep FS invariants
    title="${title//$'\t'/ }"
    printf '%s\t%s\t%s\n' "$id" "$title" "${dir%/}"
  done
}

# Render a cached paper through glow if available, else less -R.
render_paper() {
  local id="$1"
  local dir_name
  if [[ "$id" == pmid:* ]]; then
    dir_name="pmid-${id#pmid:}"
  else
    dir_name="$id"
  fi
  local cache_file="${CACHE_DIR}/${dir_name}/paper.md"
  if [ ! -f "$cache_file" ]; then
    err "not cached: $id"
    return 1
  fi

  if command -v glow >/dev/null 2>&1; then
    glow -p "$cache_file"
  elif command -v less >/dev/null 2>&1; then
    less -R "$cache_file"
  else
    cat "$cache_file"
  fi
}

cmd_browse() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        cat <<EOF
Usage: paper7 browse

Opens an fzf picker over cached papers (arXiv + PubMed). Enter renders
the selected paper via glow (falls back to less). Esc quits.

Requirements:
  fzf       required — https://github.com/junegunn/fzf
  glow      recommended — https://github.com/charmbracelet/glow
            (if missing, less -R is used as fallback)

Cache lives at ~/.paper7/cache/. Populate it with 'paper7 get <id>'.
EOF
        return 0
        ;;
      -*) err "unknown flag: $1"; return 1 ;;
      *)  err "unexpected argument: $1"; return 1 ;;
    esac
  done

  if ! command -v fzf >/dev/null 2>&1; then
    err "fzf not installed — install with: brew install fzf (macOS) or apt install fzf (debian/ubuntu)"
    return 1
  fi

  ensure_cache_dir
  local entries
  entries=$(list_browse_entries)
  if [ -z "$entries" ]; then
    echo "No papers cached. Run 'paper7 get <id>' or 'paper7 search <query>' first."
    return 0
  fi

  local selected
  # fzf preview: {3} is the cache dir column. Show head of paper.md.
  # `|| true` so Esc (exit 130) doesn't trip set -e in the caller.
  selected=$(printf '%s\n' "$entries" | fzf \
    --delimiter=$'\t' \
    --with-nth=2 \
    --preview='head -40 {3}/paper.md' \
    --preview-window='right:60%:wrap' \
    --header='Enter: read | Esc: quit' \
    --ansi \
    || true)

  [ -z "$selected" ] && return 0

  local id
  id=$(printf '%s' "$selected" | cut -f1)
  render_paper "$id"
}

# --- KB (sqlite3 + FTS5 + optional sqlite-vec) ---

KB_DB="${HOME}/.paper7/kb.sqlite"
KB_VEC_EXT=""
# Detect sqlite-vec extension installed by install.sh
for _ext in "${HOME}/.paper7/sqlite-vec.dylib" "${HOME}/.paper7/sqlite-vec.so"; do
  [ -f "$_ext" ] && KB_VEC_EXT="$_ext" && break
done
unset _ext

_kb_require_sqlite3() {
  if ! command -v sqlite3 >/dev/null 2>&1; then
    err "sqlite3 not found — install with: brew install sqlite (macOS) or apt install sqlite3"
    return 1
  fi
}

_kb_sql() {
  if [ -n "$KB_VEC_EXT" ]; then
    sqlite3 "$KB_DB" ".load ${KB_VEC_EXT}" "$@"
  else
    sqlite3 "$KB_DB" "$@"
  fi
}

_kb_init_db() {
  _kb_sql "
    CREATE TABLE IF NOT EXISTS papers (
      id        TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      authors   TEXT,
      abstract  TEXT,
      body      TEXT NOT NULL,
      source    TEXT,
      added_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts
      USING fts5(id UNINDEXED, title, authors, abstract, body, content=papers, content_rowid=rowid);
    CREATE TRIGGER IF NOT EXISTS papers_ai AFTER INSERT ON papers BEGIN
      INSERT INTO papers_fts(rowid, id, title, authors, abstract, body)
        VALUES (new.rowid, new.id, new.title, new.authors, new.abstract, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS papers_ad AFTER DELETE ON papers BEGIN
      INSERT INTO papers_fts(papers_fts, rowid, id, title, authors, abstract, body)
        VALUES ('delete', old.rowid, old.id, old.title, old.authors, old.abstract, old.body);
    END;
  "
  # Add vectors table if sqlite-vec is available
  if [ -n "$KB_VEC_EXT" ]; then
    _kb_sql "
      CREATE TABLE IF NOT EXISTS paper_chunks (
        id        TEXT NOT NULL,
        seq       INTEGER NOT NULL,
        text      TEXT NOT NULL,
        PRIMARY KEY (id, seq)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec
        USING vec0(embedding float[768]);
    " 2>/dev/null || true
  fi
}

_kb_parse_paper() {
  local file="$1"
  local id="$2"
  awk -v id="$id" '
    BEGIN { title=""; authors="" }
    NR==1 && /^# / { title=substr($0,3); next }
    /^\*\*Authors:\*\*/ { line=$0; sub(/^\*\*Authors:\*\* */, "", line); authors=line }
    { body=body $0 "\n" }
    END {
      gsub(/\047/, "\047\047", title)
      gsub(/\047/, "\047\047", authors)
      gsub(/\047/, "\047\047", body)
      gsub(/\047/, "\047\047", id)
      printf "INSERT INTO papers(id,title,authors,abstract,body,source) VALUES(\047%s\047,\047%s\047,\047%s\047,\047\047,\047%s\047,\047arxiv\047);\n", id, title, authors, body
    }
  ' "$file"
}

cmd_kb() {
  local subcmd="${1:-}"
  shift 2>/dev/null || true

  case "$subcmd" in
    add)
      _kb_require_sqlite3 || return 1
      if [[ $# -eq 0 ]]; then
        err "usage: paper7 kb add <id> [get-options]"
        return 1
      fi
      local paper_id="$1"; shift
      _kb_init_db

      local tmp_file
      tmp_file=$(mktemp /tmp/paper7-kb-XXXXXX.md)
      info "fetching $paper_id..."
      bash "$0" get "$paper_id" --detailed --no-refs "$@" > "$tmp_file"

      local title
      title=$(head -1 "$tmp_file" | sed 's/^# //')

      info "indexing..."
      local sql
      sql=$(_kb_parse_paper "$tmp_file" "$paper_id")
      # DELETE first so FTS delete trigger fires, then INSERT triggers FTS insert
      _kb_sql "DELETE FROM papers WHERE id='$(printf '%s' "$paper_id" | sed "s/'/''/g")'; ${sql}"
      rm -f "$tmp_file"

      echo -e "${GREEN}added${RESET} $title"
      echo "  id: $paper_id"
      ;;

    search)
      _kb_require_sqlite3 || return 1
      if [[ $# -eq 0 ]]; then
        err "usage: paper7 kb search <query> [--n N]"
        return 1
      fi
      local n=5 query=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --n) n="$2"; shift 2 ;;
          *) query="${query} $1"; shift ;;
        esac
      done
      query="${query# }"
      _kb_init_db
      # Build FTS5 query: wrap each token so hyphens don't confuse the parser
      local safe_query fts_query
      safe_query=$(printf '%s' "$query" | sed "s/'/''/g")
      fts_query=$(printf '%s' "$safe_query" | tr ' ' '\n' | awk 'NF{printf "\"%s\" ", $0}')
      _kb_sql "
        SELECT p.id, p.title, coalesce(p.authors,''),
               snippet(papers_fts, 4, char(171), char(187), '...', 20),
               round(-bm25(papers_fts), 6)
        FROM papers_fts
        JOIN papers p ON papers_fts.id = p.id
        WHERE papers_fts MATCH '${fts_query}'
        ORDER BY bm25(papers_fts)
        LIMIT ${n};
      " -separator '|' | awk -F'|' '
        NF>=4 {
          printf "\033[1m%s\033[0m — %s\n", $2, $3
          printf "  id: %s  score: %s\n", $1, $5
          printf "  %s\n\n", $4
        }
      '
      ;;

    remove)
      _kb_require_sqlite3 || return 1
      if [[ $# -eq 0 ]]; then
        err "usage: paper7 kb remove <id>"
        return 1
      fi
      local paper_id="$1"
      _kb_sql "DELETE FROM papers WHERE id='$(printf '%s' "$paper_id" | sed "s/'/''/g")';"
      echo "removed $paper_id"
      ;;

    list)
      _kb_require_sqlite3 || return 1
      _kb_init_db
      _kb_sql "SELECT id, title, authors, added_at FROM papers ORDER BY added_at DESC;" \
        -separator $'\t' | awk -F'\t' '{
          printf "\033[1m%s\033[0m — %s\n  authors: %s\n  added: %s\n\n", $2, $1, $3, $4
        }'
      ;;

    status)
      _kb_require_sqlite3 || return 1
      _kb_init_db
      local count
      count=$(_kb_sql "SELECT COUNT(*) FROM papers;")
      echo "KB: ${count} papers indexed"
      echo "DB: ${KB_DB}"
      if [ -n "$KB_VEC_EXT" ]; then
        echo "Vector search: enabled (sqlite-vec)"
      else
        echo "Vector search: disabled (sqlite-vec not found at ~/.paper7/)"
      fi
      ;;

    ''|--help|-h)
      cat <<EOF
Usage: paper7 kb <subcommand> [options]

Subcommands:
  add <id> [get-opts]   Fetch paper and index it in the local KB
  search <query>        Full-text search (BM25) across KB papers
  list                  List all indexed papers
  remove <id>           Remove a paper from the KB
  status                Show KB stats and index info

Index stored at: ~/.paper7/kb.sqlite
Vector search via sqlite-vec is enabled automatically when installed.

Examples:
  paper7 kb add 1706.03762
  paper7 kb add 2005.11401 --no-refs
  paper7 kb search "attention mechanism"
  paper7 kb search "query expansion" --n 10
  paper7 kb list
  paper7 kb status
EOF
      ;;

    *)
      err "unknown kb subcommand: $subcmd"
      echo "  paper7 kb --help for usage" >&2
      return 1
      ;;
  esac
}

# --- Main ---

main() {
  if [[ $# -eq 0 ]]; then
    usage
    exit 1
  fi

  local cmd="$1"
  shift

  case "$cmd" in
    get)        cmd_get "$@" ;;
    search)     cmd_search "$@" ;;
    repo)       cmd_repo "$@" ;;
    list)       cmd_list ;;
    cache)      cmd_cache "$@" ;;
    vault)      cmd_vault "$@" ;;
    browse)     cmd_browse "$@" ;;
    refs)       cmd_refs "$@" ;;
    kb)         cmd_kb "$@" ;;
    help|--help|-h)  usage ;;
    --version|-v)    echo "paper7 $VERSION" ;;
    *)
      err "unknown command: $cmd"
      echo ""
      usage
      exit 1
      ;;
  esac
}

if [ "${PAPER7_NO_MAIN:-0}" = "0" ]; then
  main "$@"
fi
