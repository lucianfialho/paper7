#!/usr/bin/env bash
set -euo pipefail

VERSION="0.1.0"
CACHE_DIR="${HOME}/.paper7/cache"
AR5IV_URL="https://ar5iv.labs.arxiv.org/html"
ARXIV_API="http://export.arxiv.org/api/query"
PUBMED_ESEARCH="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
PUBMED_ESUMMARY="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"

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
  get <id>             Fetch paper and convert to markdown
  repo <id>            Find GitHub repositories for a paper
  list                 List cached papers in your KB
  cache clear [id]     Clear cache (all or specific paper)
  vault init <path>    Configure Obsidian-compatible vault path
  vault <id>           Export paper to vault as Obsidian-ready Markdown
  vault all            Export all cached papers to vault
  help                 Show this help

${BOLD}Options:${RESET}
  --help, -h           Show help
  --version, -v        Show version

${BOLD}Examples:${RESET}
  paper7 search "mixture of experts"
  paper7 search "psilocybin hypertension" --source pubmed --max 5
  paper7 get 2401.04088
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

ensure_cache_dir() {
  mkdir -p "$CACHE_DIR"
}

load_config() {
  local config_file="${HOME}/.paper7/config"
  PAPER7_VAULT=""
  [ -f "$config_file" ] || return 0
  PAPER7_VAULT=$(grep '^PAPER7_VAULT=' "$config_file" 2>/dev/null | head -1 | cut -d= -f2- || true)
}

# --- Commands ---

cmd_get() {
  local no_cache=false
  local no_refs=false
  local input=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-cache) no_cache=true; shift ;;
      --no-refs)  no_refs=true; shift ;;
      --help|-h)  echo "Usage: paper7 get <id> [--no-refs] [--no-cache]"; return 0 ;;
      -*) err "unknown flag: $1"; return 1 ;;
      *)  input="$1"; shift ;;
    esac
  done

  if [ -z "$input" ]; then
    err "missing paper ID. Usage: paper7 get <id>"
    return 1
  fi

  local id
  id=$(parse_arxiv_id "$input") || return 1

  local cache_file="${CACHE_DIR}/${id}/paper.md"
  local meta_file="${CACHE_DIR}/${id}/meta.json"

  # Check cache
  if [ "$no_cache" = false ] && [ -f "$cache_file" ]; then
    info "cached: $cache_file"
    if [ "$no_refs" = true ]; then
      sed '/^## References/,$d' "$cache_file"
    else
      cat "$cache_file"
    fi
    return 0
  fi

  ensure_cache_dir
  mkdir -p "${CACHE_DIR}/${id}"

  local html_file="${CACHE_DIR}/${id}/raw.html"

  # Fetch metadata from arXiv API (clean title + authors)
  info "fetching metadata for $id ..."
  local api_file="${CACHE_DIR}/${id}/api.xml"
  curl -sL -o "$api_file" "https://export.arxiv.org/api/query?id_list=${id}&max_results=1"

  local title
  title=$(sed -n 's/.*<title>\(.*\)<\/title>.*/\1/p' "$api_file" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//' || true)
  [ -z "$title" ] && title="Unknown Title"

  local authors
  authors=$(sed -n 's/.*<name>\(.*\)<\/name>.*/\1/p' "$api_file" 2>/dev/null | tr '\n' ',' | sed 's/,$//' | sed 's/,/, /g' || true)
  [ -z "$authors" ] && authors="Unknown Authors"

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

  # Build markdown: header + converted content
  {
    echo "# ${title}"
    echo ""
    echo "**Authors:** ${authors}"
    echo "**arXiv:** https://arxiv.org/abs/${id}"
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

  # Save metadata
  cat > "$meta_file" <<META
{"id":"${id}","title":"$(echo "$title" | sed 's/"/\\"/g')","authors":"$(echo "$authors" | sed 's/"/\\"/g' | head -c 200)"}
META

  # Clean up raw HTML
  rm -f "$html_file"

  info "cached: $cache_file"

  # Output
  if [ "$no_refs" = true ]; then
    sed '/^## References/,$d' "$cache_file"
  else
    cat "$cache_file"
  fi
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

    local id
    id=$(basename "$dir")
    local title="(no title)"

    local meta_file="${dir}meta.json"
    if [ -f "$meta_file" ]; then
      local extracted
      extracted=$(grep -o '"title":"[^"]*"' "$meta_file" | sed 's/"title":"//;s/"$//' | head -1)
      [ -n "$extracted" ] && title="$extracted"
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
        local id
        id=$(parse_arxiv_id "$target") || return 1
        if [ -d "${CACHE_DIR}/${id}" ]; then
          rm -rf "${CACHE_DIR}/${id}"
          echo "Removed paper $id from cache"
        else
          err "paper $id not in cache"
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

main "$@"
