# Benchmark: Size Reduction

Real output files from 5 landmark papers, comparing paper7's clean Markdown against raw PDF and HTML sources.

## Results

| Paper | Pages | PDF | HTML (ar5iv) | paper7 | vs PDF | vs HTML |
|-------|------:|----:|-----------:|-------:|-------:|--------:|
| Attention Is All You Need | 15 | 2,215KB | 352KB | 42KB | **-98%** | **-88%** |
| RAG | 12 | 885KB | 309KB | 70KB | **-92%** | **-77%** |
| Mixtral of Experts | 16 | 2,476KB | 222KB | 32KB | **-99%** | **-85%** |
| GPT-4 Technical Report | 100 | 5,246KB | 650KB | 119KB | **-98%** | **-82%** |
| LoRA | 26 | 1,610KB | 1,049KB | 94KB | **-94%** | **-91%** |
| **Total** | **169** | **12,432KB** | **2,582KB** | **358KB** | **-97%** | **-86%** |

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
# Run the benchmark script
./benchmark/run.sh

# Or manually for a single paper
paper7 get <arxiv-id> > benchmark/<folder>/paper7.md
```

## Notes

- PDFs and HTML are not included in the repo (too large)
- The bigger the paper, the bigger the savings
- Run `benchmark/run.sh` to regenerate all numbers
