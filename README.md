# paper7

**arXiv papers as clean Markdown for LLMs.** Zero dependencies. Bash-only.

Like [context7](https://github.com/upstash/context7) but for academic papers.

```bash
paper7 get 2401.04088 | claude "summarize this paper"
```

## Benchmark

Tested with 5 landmark papers (Attention, RAG, Mixtral, GPT-4, LoRA) — 169 pages total:

```
                          Size (5 papers combined)

  Raw PDF       ████████████████████████████████████████████████  12,140KB
  HTML (ar5iv)  ██████████████████                                2,522KB
  paper7        ██                                                  349KB  (-97% vs PDF)
```

| Paper | Pages | PDF | HTML | paper7 | vs PDF | vs HTML |
|-------|------:|----:|-----:|-------:|-------:|--------:|
| Attention Is All You Need | 15 | 2,163KB | 343KB | 40KB | -98% | -88% |
| RAG | 12 | 864KB | 301KB | 68KB | -92% | -77% |
| Mixtral of Experts | 16 | 2,417KB | 216KB | 31KB | -98% | -85% |
| **GPT-4 Technical Report** | **100** | **5,122KB** | **635KB** | **116KB** | **-97%** | **-81%** |
| LoRA | 26 | 1,571KB | 1,024KB | 91KB | -94% | -91% |
| **Total** | **169** | **12,140KB** | **2,522KB** | **349KB** | **-97%** | **-86%** |

> Reproduce with `./benchmark/run.sh`

## How It Works

```
search "topic" ──> choose papers ──> get (fetch + clean) ──> use as LLM context
                                          │
                                          ▼
                                    ~/.paper7/
                                    └── cache/
                                        ├── 2401.04088/
                                        │   ├── paper.md    ← clean markdown
                                        │   └── meta.json   ← title, authors
                                        └── 1706.03762/
                                            ├── paper.md
                                            └── meta.json
```

1. **Search** arXiv API for papers by keyword
2. **Fetch** full text from [ar5iv](https://ar5iv.labs.arxiv.org) (HTML version of arXiv — no PDF parsing needed)
3. **Convert** to clean Markdown with proper headers, paragraphs, and structure
4. **Cache** locally as your knowledge base

## Install

```bash
curl -sSL https://raw.githubusercontent.com/lucianfialho/paper7/main/install.sh | bash
```

Or manually:

```bash
mkdir -p ~/.local/bin
curl -sL https://raw.githubusercontent.com/lucianfialho/paper7/main/paper7.sh -o ~/.local/bin/paper7
chmod +x ~/.local/bin/paper7
```

**Dependencies:** `curl`, `sed`, `grep`, `awk` — already on any Unix system.

## Usage

### Search for papers

```bash
$ paper7 search "mixture of experts" --max 3

Found 55723 papers (showing 3):

  [2401.04088] Mixtral of Experts
  Albert Q. Jiang, Alexandre Sablayrolles, ... (2024-01-08)

  [2410.17954] ExpertFlow: Efficient Mixture-of-Experts Inference
  Xin He, Shunkang Zhang, ... (2024-10-23)
```

### Fetch a paper

```bash
paper7 get 2401.04088                          # by ID
paper7 get https://arxiv.org/abs/2401.04088    # by URL
paper7 get 2401.04088 --no-refs                # strip references
paper7 get 2401.04088 --no-cache               # force re-download
```

### Find the source code

```bash
$ paper7 repo 2401.04088

Repositories for 2401.04088:
  https://github.com/mistralai/mistral-src
```

### Manage your knowledge base

```bash
$ paper7 list

  2401.04088  Mixtral of Experts
  1706.03762  Attention Is All You Need
  2005.11401  RAG for Knowledge-Intensive NLP Tasks

3 paper(s), 184K total

$ paper7 cache clear 2401.04088   # remove one
$ paper7 cache clear              # clear all
```

### Pipe to anything

```bash
paper7 get 2401.04088 | wc -w                          # word count
paper7 get 2401.04088 --no-refs > paper.md              # save to file
paper7 get 2401.04088 | pbcopy                          # clipboard (macOS)
paper7 get 2401.04088 | claude "explain the key ideas"  # feed to LLM
```

## Why Not Just Use PDF?

| | Raw PDF | HTML | paper7 |
|---|---|---|---|
| Size | Huge (images, fonts, layout) | Large (CSS, scripts, nav) | Minimal (text only) |
| Structure | None (flat binary) | Buried in markup | Clean Markdown headers |
| Two-column layout | Broken flow | Preserved but noisy | Linear text |
| Headers/footers | Every page | Navigation chrome | Removed |
| Math formulas | Garbled | HTML entities | Cleaned |
| Authors/metadata | In body noise | Mixed with UI | Structured header |
| Caching/KB | No | No | Built-in |
| Dependencies | AI Vision API / poppler | Browser | curl (any Unix) |

## Research

The approach of extracting clean text instead of sending raw PDFs to LLMs is supported by academic research. See [`examples/research-kb/`](examples/research-kb/) for a knowledge base built with paper7 itself, including:

- **Lost in the Middle** (Liu et al., 2023) — LLMs lose 20%+ performance when relevant info is buried in long, noisy contexts
- **PDF-WuKong** (Xie et al., 2024) — sparse sampling reduces tokens by ~89% while improving comprehension
- **Comparative Study of PDF Parsing Tools** (Adhikari & Agarwal, 2024) — recommends Markdown/LaTeX output for scientific documents

## License

MIT
