<h1 align="center">paper7</h1>

<p align="center">
  Turn any arXiv paper into clean Markdown — at runtime, with zero dependencies.<br>
  <strong>97% smaller than PDF. 86% smaller than raw HTML.</strong><br><br>
  <a href="#benchmark"><strong>See the benchmark →</strong></a>
</p>

## Install

```bash
curl -sSL https://raw.githubusercontent.com/lucianfialho/paper7/main/install.sh | bash
```

## AI Agent Skill

paper7 ships with an installable [skill](https://skills.sh) that teaches AI coding agents (Claude Code, Cursor, Codex) how to use it. Once installed, your agent can search arXiv and fetch papers directly into the conversation.

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
- `paper7 get 2401.04088` — fetch a paper as clean Markdown
- "Research whether LoRA or full fine-tuning is better for my use case" — triggers the research skill

## Usage

```bash
# Search arXiv
paper7 search "mixture of experts" --max 5

# Fetch a paper as clean Markdown
paper7 get 2401.04088
paper7 get https://arxiv.org/abs/2401.04088
paper7 get 2401.04088 --no-refs                # strip references
paper7 get 2401.04088 --no-cache               # force re-download

# Find source code
paper7 repo 2401.04088

# Manage your local knowledge base
paper7 list                                     # show cached papers
paper7 cache clear 2401.04088                   # remove one
paper7 cache clear                              # clear all

# Pipe to anything
paper7 get 2401.04088 | claude "explain this"   # Claude Code
paper7 get 2401.04088 | llm "summarize"         # simon willison's llm
paper7 get 2401.04088 | pbcopy                  # clipboard (macOS)
paper7 get 2401.04088 --no-refs > paper.md      # save to file
```

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

1. **Search** arXiv API for papers by keyword
2. **Fetch** full text from [ar5iv](https://ar5iv.labs.arxiv.org) (HTML version of arXiv — no PDF parsing)
3. **Convert** HTML to clean Markdown with proper `##` headers, paragraphs, and structure
4. **Cache** locally at `~/.paper7/cache/`

paper7 skips PDF parsing entirely. ar5iv provides arXiv papers as HTML, which is the same source content without the binary layout overhead. paper7 extracts the article body, converts HTML tags to Markdown, and strips everything else.

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
  search <query>       Search arXiv papers by keyword
  get <id>             Fetch paper and convert to Markdown
  repo <id>            Find GitHub repositories for a paper
  list                 List cached papers
  cache clear [id]     Clear cache (all or specific paper)

Options:
  --max N              Max search results (default: 10)
  --sort relevance|date  Sort search results
  --no-refs            Strip references section
  --no-cache           Force re-download
  --help, -h           Show help
  --version, -v        Show version
```

---

## License

[MIT](LICENSE)

---

<sub>Like [context7](https://github.com/upstash/context7) but for academic papers. Pure Bash — requires only curl, sed, grep, awk.</sub>
