# Benchmark: Size Reduction

Real output files from 5 landmark papers, comparing paper7's clean Markdown against raw PDF and HTML sources.

## Results

| Paper | Pages | PDF | HTML (ar5iv) | paper7 | vs PDF | vs HTML |
|-------|------:|----:|-----------:|-------:|-------:|--------:|
| Attention Is All You Need | 15 | 2,163KB | 343KB | 40KB | **-98%** | **-88%** |
| RAG | 12 | 864KB | 301KB | 68KB | **-92%** | **-77%** |
| Mixtral of Experts | 16 | 2,417KB | 216KB | 31KB | **-98%** | **-85%** |
| GPT-4 Technical Report | 100 | 5,122KB | 635KB | 116KB | **-97%** | **-81%** |
| LoRA | 26 | 1,571KB | 1,024KB | 91KB | **-94%** | **-91%** |
| **Total** | **169** | **12,140KB** | **2,522KB** | **349KB** | **-97%** | **-86%** |

## What's compared

| Source | Description |
|--------|------------|
| **PDF** | Raw PDF from arxiv.org — what you'd send via a vision API (~1,500 tokens/page) |
| **HTML** | Raw HTML from ar5iv.labs.arxiv.org — full page with CSS, scripts, navigation |
| **paper7** | Clean Markdown extracted by paper7 — headers, paragraphs, no noise |

## Papers

Each folder contains `paper7.md` — the clean Markdown output:

| Folder | Paper | arXiv ID |
|--------|-------|----------|
| `attention/` | Attention Is All You Need | 1706.03762 |
| `rag/` | Retrieval-Augmented Generation | 2005.11401 |
| `mixtral/` | Mixtral of Experts | 2401.04088 |
| `gpt4/` | GPT-4 Technical Report | 2303.08774 |
| `lora/` | LoRA: Low-Rank Adaptation | 2106.09685 |

## How to reproduce

```bash
# Run the deterministic benchmark command
bun run benchmark

# Refresh upstream-derived artifacts and re-run benchmark (live mode)
bun run benchmark:live

# Run startup and cached-get performance benchmark (requires built dist/)
bun run benchmark:cli

# Or manually for a single paper
paper7 get <arxiv-id> > benchmark/<folder>/paper7.md
```

## Notes

- PDFs and HTML are not included in the repo (too large)
- The bigger the paper, the bigger the savings
- Live refresh hits arXiv/ar5iv and rewrites `benchmark/*/paper7.md` plus `benchmark/manifest.json`
