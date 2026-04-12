#!/usr/bin/env bash
set -eo pipefail

# Benchmark: compare paper7 output size vs raw PDF and HTML
# Usage: ./benchmark/run.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PAPER7="${SCRIPT_DIR}/../paper7.sh"

NAMES="attention rag mixtral gpt4 lora"
IDS="1706.03762 2005.11401 2401.04088 2303.08774 2106.09685"
PAGE_COUNTS="15 12 16 100 26"

get_field() { echo "$2" | awk -v n="$1" '{print $n}'; }

fmt_kb() { echo "$(($1 / 1024))KB"; }

pct() { echo "$(( ($2 - $1) * 100 / $1 ))%"; }

echo "Running paper7 benchmark..."
echo ""

printf "%-30s %6s %8s %10s %10s %8s %8s\n" "Paper" "Pages" "PDF" "HTML" "paper7" "vs PDF" "vs HTML"
printf "%-30s %6s %8s %10s %10s %8s %8s\n" "-----" "-----" "---" "----" "------" "------" "-------"

total_pdf=0
total_html=0
total_paper7=0
total_pages=0
i=1

for name in $NAMES; do
  id=$(get_field $i "$IDS")
  pages=$(get_field $i "$PAGE_COUNTS")
  dir="${SCRIPT_DIR}/${name}"
  mkdir -p "$dir"

  # Fetch paper7 output
  "$PAPER7" get "$id" --no-cache > "${dir}/paper7.md" 2>/dev/null

  # Get PDF size (download to temp)
  pdf_tmp=$(mktemp)
  curl -sL "https://arxiv.org/pdf/${id}" -o "$pdf_tmp"
  pdf_size=$(wc -c < "$pdf_tmp" | tr -d ' ')
  rm -f "$pdf_tmp"

  # Get HTML size
  html_size=$(curl -sL "https://ar5iv.labs.arxiv.org/html/${id}" | wc -c | tr -d ' ')

  # Get paper7 size
  p7_size=$(wc -c < "${dir}/paper7.md" | tr -d ' ')

  total_pdf=$((total_pdf + pdf_size))
  total_html=$((total_html + html_size))
  total_paper7=$((total_paper7 + p7_size))
  total_pages=$((total_pages + pages))

  printf "%-30s %6d %8s %10s %10s %8s %8s\n" \
    "$name ($id)" \
    "$pages" \
    "$(fmt_kb "$pdf_size")" \
    "$(fmt_kb "$html_size")" \
    "$(fmt_kb "$p7_size")" \
    "$(pct "$pdf_size" "$p7_size")" \
    "$(pct "$html_size" "$p7_size")"

  i=$((i + 1))
done

echo ""
printf "%-30s %6d %8s %10s %10s %8s %8s\n" \
  "TOTAL" \
  "$total_pages" \
  "$(fmt_kb "$total_pdf")" \
  "$(fmt_kb "$total_html")" \
  "$(fmt_kb "$total_paper7")" \
  "$(pct "$total_pdf" "$total_paper7")" \
  "$(pct "$total_html" "$total_paper7")"

echo ""
echo "Done. Results saved in ${SCRIPT_DIR}/*/paper7.md"
