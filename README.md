<h1 align="center">paper7</h1>

<p align="center">
  Turn arXiv, PubMed, and DOI papers into clean Markdown.<br>
  <strong>97% smaller than PDF. 86% smaller than raw HTML.</strong><br><br>
  <a href="#benchmark"><strong>See the benchmark →</strong></a>
</p>

## Install

```bash
npm install -g @guataiba/paper7

# Or run without installing
npx @guataiba/paper7 search "attention mechanism"
```

## AI Agent Skill

paper7 ships with an installable [skill](https://skills.sh) that teaches AI coding agents (Claude Code, Cursor, Codex) how to use it. Once installed, your agent can search arXiv or PubMed and fetch papers directly into the conversation.

```bash
# Core skill — search and fetch papers
npx skills add lucianfialho/paper7 --skill paper7

# Research skill — guided literature review before implementation
npx skills add lucianfialho/paper7 --skill paper7-research
```

Or manually as a Claude Code slash command:

```bash
mkdir -p ~/.claude/commands
curl -sL https://raw.githubusercontent.com/lucianfialho/paper7/main/claude-code/paper7.md \
  -o ~/.claude/commands/paper7.md
```

After installing, try prompts like:
- `paper7 search "attention mechanism"` — search arXiv
- `paper7 get 2401.04088` — fetch a compact paper header with summary + section index
- `paper7 get 2401.04088 --detailed --range 35:67` — fetch just one detailed slice
- "Research whether LoRA or full fine-tuning is better for my use case" — triggers the research skill

## Usage

```bash
# Search arXiv (default)
paper7 search "mixture of experts" --max 5

# Search PubMed (biomedical, clinical, pharmacological)
paper7 search "psilocybin hypertension" --source pubmed --max 5

# Fetch a paper (compact indexed header by default)
paper7 get 2401.04088                          # arXiv
paper7 get 2401.04088 --detailed               # full paper
paper7 get 2401.04088 --detailed --range 35:67 # just lines 35-67 from full paper
paper7 get https://arxiv.org/abs/2401.04088
paper7 get pmid:38903003                       # PubMed (abstract only)
paper7 get doi:10.1101/2023.12.15.571821       # any DOI via Crossref (bioRxiv, medRxiv, etc.)
paper7 get 2401.04088 --no-refs                # strip references
paper7 get 2401.04088 --no-cache               # force re-download

# Find source code
paper7 repo 2401.04088

# List references via Semantic Scholar
paper7 refs 1706.03762 --max 5
paper7 refs 1706.03762 --json                    # raw JSON for scripts

# Manage your local knowledge base
paper7 list                                     # show cached papers
paper7 cache clear 2401.04088                   # remove one
paper7 cache clear                              # clear all

# Export to an Obsidian-compatible vault (frontmatter + wikilinks)
paper7 vault init ~/Documents/ArxivVault        # configure vault path once
paper7 vault 2401.04088                         # export one paper
paper7 vault all                                # export every cached paper

# Browse the local cache interactively
paper7 browse                                   # Node stdin/stdout picker; Enter renders, q quits

# Pipe to anything
paper7 get 2401.04088 | claude "which section should I read?"      # compact header first
paper7 get 2401.04088 --detailed --range 35:67 | claude "explain"  # just one section slice
paper7 get 2401.04088 --detailed | llm "summarize"                 # simon willison's llm
paper7 get 2401.04088 --detailed | pbcopy                          # clipboard (macOS)
paper7 get 2401.04088 --detailed --no-refs > paper.md              # save full paper to file

# End-to-end: search PubMed, then fetch and summarize
paper7 search "psilocybin hypertension" --source pubmed --max 3
paper7 get pmid:38903003 | claude "summarize the clinical case"
```

## Sources

paper7 queries one of two sources per search; pick based on the topic:

- **`arxiv`** (default): physics, computer science, machine learning, math, quantitative biology. Full-text available.
- **`pubmed`**: biomedical, clinical, and pharmacological literature. Abstracts only (full text on PMC is a separate pipeline).

PubMed results use a `pmid:` prefix on the ID; arXiv IDs keep the native `YYMM.NNNNN` form. Both coexist in the same local cache.

`paper7 get doi:<DOI>` covers anything with a DOI — bioRxiv, medRxiv, PsyArXiv, ChemRxiv, journal articles — via Crossref (metadata + abstract). bioRxiv/medRxiv full text isn't available (their pages block direct HTTP); the rendered Markdown includes a `**Full text:**` link.

Semantic Scholar is also wired in as a metadata layer (not a full-paper fetcher): `paper7 refs <id>` lists canonical references, and `paper7 get --detailed` enriches its Markdown header with an auto-generated `**TLDR:**` line when one exists. Plain `paper7 get` emits a compact header with a summary and line-indexed sections so agents can fetch only the ranges they need.

For per-source endpoints, rate limits, auth, and known gaps see [docs/sources.md](docs/sources.md).

## Benchmark

Tested with 5 landmark papers (Attention, RAG, Mixtral, GPT-4, LoRA) — 169 pages total:

```
                          Size (5 papers combined)

  Raw PDF       ████████████████████████████████████████████████  12,140KB
  HTML (ar5iv)  ██████████████████                                 2,522KB
  paper7        ██                                                   349KB  (-97% vs PDF)
```

| Paper | Pages | PDF | HTML | paper7 | vs PDF | vs HTML |
|-------|------:|----:|-----:|-------:|-------:|--------:|
| Attention Is All You Need | 15 | 2,163KB | 343KB | 40KB | -98% | -88% |
| RAG | 12 | 864KB | 301KB | 68KB | -92% | -77% |
| Mixtral of Experts | 16 | 2,417KB | 216KB | 31KB | -98% | -85% |
| GPT-4 Technical Report | 100 | 5,122KB | 635KB | 116KB | -97% | -81% |
| LoRA | 26 | 1,571KB | 1,024KB | 91KB | -94% | -91% |
| **Total** | **169** | **12,140KB** | **2,522KB** | **349KB** | **-97%** | **-86%** |

Reproduce with `./benchmark/run.sh`.

## How it works

**arXiv flow** (full-text):

1. **Search** arXiv API for papers by keyword
2. **Fetch** full text from [ar5iv](https://ar5iv.labs.arxiv.org) (HTML version of arXiv — no PDF parsing)
3. **Convert** HTML to clean Markdown with proper `##` headers, paragraphs, and structure
4. **Cache** locally at `~/.paper7/cache/<arxiv_id>/`

**PubMed flow** (abstract-only):

1. **Search** NCBI E-utilities (`esearch` + `esummary`) for papers by keyword
2. **Fetch** abstract via `efetch` (XML) — full text lives on PMC and is a separate pipeline
3. **Convert** XML to clean Markdown with title, authors, journal, DOI, and abstract (labeled sections preserved)
4. **Cache** locally at `~/.paper7/cache/pmid-<NNN>/`

paper7 skips PDF parsing entirely. For arXiv, ar5iv provides the same content as HTML without binary layout overhead. For PubMed, the E-utilities XML is already structured metadata. In both cases, paper7 extracts the body, converts tags to Markdown, and strips everything else.

## Runtime and Package Policy

The npm package ships prebuilt `dist/` JavaScript and has no install-time build, `install`, or `postinstall` script. Runtime dependencies are intentionally limited to `effect` and `@effect/platform-node`; normal operation does not depend on shelling out to `curl`, `sed`, `grep`, `awk`, `xmllint`, or external HTML/XML parsers. HTML/XML handling is covered by deterministic fixture tests in `tests/fixtures/`.

## Why not just use PDF?

| | Raw PDF | paper7 |
|---|---|---|
| Size | ~12MB for 5 papers | ~350KB (-97%) |
| Structure | Flat binary, no sections | Markdown with `##` headers |
| Two-column layout | Broken text flow | Linear reading order |
| Page headers/footers | Repeated every page | Removed |
| Math notation | Garbled or requires Vision API | Cleaned |
| Metadata | Mixed into body text | Structured header |
| Local cache | No | Built-in knowledge base |
| Dependencies | Vision API or poppler | `curl` |

## Research

The clean-text-over-raw-PDF approach is backed by academic research. See [`examples/research-kb/`](examples/research-kb/) for a knowledge base built with paper7 itself:

- **[Lost in the Middle](https://arxiv.org/abs/2307.03172)** (Liu et al., 2023) — LLMs lose 20%+ performance when relevant info is buried in long, noisy contexts
- **[PDF-WuKong](https://arxiv.org/abs/2410.05970)** (Xie et al., 2024) — sparse sampling reduces tokens by ~89% while improving comprehension
- **[Comparative Study of PDF Parsing](https://arxiv.org/abs/2410.09871)** (Adhikari & Agarwal, 2024) — recommends Markdown/LaTeX for scientific documents

## CLI reference

```
paper7 <command> [options]

Commands:
  search <query>       Search papers by keyword (arXiv or PubMed)
  get <id>             Fetch paper; compact header by default, full text with --detailed
                       id shapes: arXiv (YYMM.NNNNN), pmid:NNN, doi:10.XXXX/...
  refs <id>            List references via Semantic Scholar
                       id shapes: YYMM.NNNNN (arXiv),
                                  https://arxiv.org/abs/... (arXiv URL),
                                  pmid:NNNNN (PubMed abstract)
  repo <id>            Find GitHub repositories for an arXiv paper
  list                 List cached papers (arXiv + PubMed)
  cache clear [id]     Clear cache (all, or a specific arXiv/pmid id)
  vault init <path>    Configure Obsidian-compatible vault
  vault <id>|all       Export arXiv paper(s) to vault with frontmatter + wikilinks
  browse               Interactive picker over the local cache

Options:
  --source SOURCE      search only — arxiv (default) or pubmed
  --max N              Max search results / references (default: 10)
  --sort relevance|date  Sort search results
  --no-refs            Strip references section (arXiv only; no-op for PubMed)
  --no-cache           Force re-download
  --no-tldr            Skip Semantic Scholar TLDR enrichment in `get`
  --detailed           Emit the full paper instead of the compact indexed header
  --range START:END    Detailed-only line slice from the full paper
  --json               Emit raw JSON (refs only)
  --help, -h           Show help
  --version, -v        Show version
```

---

## License

[MIT](LICENSE)

---

<sub>Like [context7](https://github.com/upstash/context7) but for academic papers.</sub>
