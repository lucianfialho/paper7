# Data sources

paper7 talks to three upstream APIs. This document catalogs each one — the endpoints used, response shape, rate limits, auth model, and known gaps — so the integration boundary is explicit and future sources (bioRxiv, OpenAlex, etc.) can follow the same template.

Conventions throughout:

- All HTTP calls send `tool=paper7` as a query parameter (NCBI + Semantic Scholar courtesy).
- Network failures degrade per-source: search/fetch exit non-zero with a stderr message; metadata enrichment (e.g. TLDR) is best-effort and silent.
- IDs visible to the user are always **canonical paper7 form**: `YYMM.NNNNN` for arXiv, `pmid:NNNN` for PubMed, `doi:...` or `s2:<paperId>` for Semantic Scholar.

---

## arXiv

### Purpose
Full-text source for physics, computer science, machine learning, math, and quantitative biology preprints. Default for `paper7 search` and `paper7 get`.

### Endpoints used

| Endpoint | Used for | Notes |
|---|---|---|
| `https://export.arxiv.org/api/query?search_query=...` | `paper7 search` (default) | Atom XML response. Sort by `relevance` or `submittedDate`. |
| `https://export.arxiv.org/api/query?id_list=<id>` | `paper7 get` (metadata only) | Used to extract canonical title + authors before pulling the body. |
| `https://ar5iv.labs.arxiv.org/html/<id>` | `paper7 get` (full body) | HTML rendering of the arXiv source — paper7 strips tags and emits clean Markdown. Skips PDF parsing entirely. |

### Response format
XML (Atom feed). Parsed with `awk` over the `<entry>` blocks.

### Rate limits
arXiv asks for ~3-second delay between bursts; paper7 issues one request per user-issued command, well under the threshold. No formal cap.

### Auth
None.

### Known gaps
- `paper7 get` falls back with a clear error if a paper is too recent or unavailable on ar5iv (HTTP 404).
- `paper7 search` URL-encodes spaces only (`s/ /+/g`); queries with `&`, `#`, or `%` are not escaped — known limitation, same on PubMed.
- Coverage is preprints only; final published versions live elsewhere.

### Upstream docs
- arXiv API user manual: https://info.arxiv.org/help/api/user-manual.html
- ar5iv project: https://ar5iv.labs.arxiv.org/

---

## PubMed (NCBI E-utilities)

### Purpose
Biomedical, clinical, and pharmacological literature. Activated via `paper7 search ... --source pubmed` and `paper7 get pmid:NNNN`.

### Endpoints used

| Endpoint | Used for | Notes |
|---|---|---|
| `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=...` | `paper7 search --source pubmed` (step 1) | Returns a list of PMIDs matching the query. |
| `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=<csv>` | `paper7 search --source pubmed` (step 2) | Hydrates each PMID with title, authors, pub date, journal. |
| `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=<id>&rettype=abstract&retmode=xml` | `paper7 get pmid:NNNN` | Returns full PubmedArticle XML — paper7 extracts title, authors, journal, publication date, DOI, and abstract. |

### Response format
XML across all three endpoints. Parsed with `grep`/`sed`/`awk` (no `xmllint` dependency).

### Rate limits
- Without API key: 3 requests/second/IP
- With free API key (https://www.ncbi.nlm.nih.gov/account/): 10 requests/second
- paper7 makes 2 requests per `search` (esearch + esummary) and 1 per `get` — well within unauth limits

### Auth
Optional. paper7 does not currently surface API key support; could be added via env var (`NCBI_API_KEY`) without breaking changes — deferred until a user hits limits in practice.

### Known gaps
- **Abstracts only.** Full text lives on PMC (PubMed Central) and is a separate pipeline not yet implemented. `paper7 get pmid:NNNN` returns metadata + abstract; users wanting full text must fetch from PMC or the publisher.
- `--no-refs` flag is a no-op for PubMed papers (abstracts have no References section).
- `paper7 vault` rejects PMIDs today — vault export for PubMed papers is deferred to a future issue once PMID-specific frontmatter is designed.
- PubDate normalization: prefers `<Year><Month><Day>` form, falls back to `<MedlineDate>` raw string when only a season/range is published (e.g. `"2025 Jul-Aug"`).

### Upstream docs
- E-utilities reference: https://www.ncbi.nlm.nih.gov/books/NBK25500/
- API key signup: https://support.nlm.nih.gov/knowledgebase/article/KA-05317/

---

## Semantic Scholar

### Purpose
Metadata-layer source. **Not** a full-paper fetcher — paper7 uses S2 for the canonical reference graph (`paper7 refs`) and per-paper TLDRs (enrichment in `paper7 get`). S2 unifies IDs across arXiv/PMID/DOI/native S2.

### Endpoints used

| Endpoint | Used for | Notes |
|---|---|---|
| `https://api.semanticscholar.org/graph/v1/paper/{externalId}/references?fields=externalIds,title,authors,year&limit=N` | `paper7 refs <id>` | Returns canonical reference list with each referenced paper's external IDs. paper7 prefers `arxiv:` > `pmid:` > `doi:` > `s2:` for the prefix it shows the user. |
| `https://api.semanticscholar.org/graph/v1/paper/{externalId}?fields=tldr` | TLDR enrichment in `paper7 get` (both arXiv and PubMed paths) | Best-effort. If S2 is rate-limited, missing the paper, or down, the TLDR line is silently omitted; the core fetch still succeeds. |

`{externalId}` accepts `arXiv:NNNN`, `PMID:NNNN`, `DOI:...`, or the raw S2 paperId (40-char hex).

### Response format
JSON. Requires `jq` for parsing — paper7 fails fast with an install hint if `jq` is missing on a S2-using command. (Same tradeoff as `fzf` for `paper7 browse`.)

### Rate limits
- Without API key: ~100 requests / 5 minutes per IP. **Easy to hit when running tests in a tight loop.**
- With free API key (https://www.semanticscholar.org/product/api#api-key-form): 1 request/second
- paper7 makes 1 request per `paper7 refs` and 1 per `paper7 get` (TLDR enrichment, skippable with `--no-tldr`)

### Auth
Optional. Currently no env var hookup; planned as a follow-up issue if rate limits become a real problem in practice.

### Known gaps
- **Best-effort enrichment.** TLDR coverage is ~80% of papers; `paper7 get` does not flag when S2 has no TLDR vs when S2 was unreachable — both render the same (no `**TLDR:**` line). Users wanting determinism can pass `--no-tldr`.
- TLDR is cached in `meta.json` and `paper.md` only on **fresh fetches** (cache miss). Already-cached papers from before this feature won't get a TLDR until the user runs `paper7 get <id> --no-cache`. There is no lazy backfill.
- `paper7 cites <id>` (reverse direction — papers citing this one) is not yet implemented; it is a planned follow-up.
- `paper7 vault` does not yet consume S2 refs — it still extracts wikilinks from the body via regex. Refactoring the vault export to use S2 refs is a separate planned issue.
- Search via S2 (`/paper/search`) is not implemented; arXiv and PubMed search cover the use cases today.

### Upstream docs
- API reference: https://api.semanticscholar.org/api-docs/graph
- Tutorials: https://api.semanticscholar.org/tutorials
- API key signup: https://www.semanticscholar.org/product/api#api-key-form

---

## Adding a new source

Use this template for the next source (bioRxiv, OpenAlex, etc.):

1. Add a constant to `paper7.sh` near the existing API URL block.
2. Add a `parse_<source>_id` and `is_<source>_input` helper if the source uses a new ID shape.
3. Add `cmd_<existing>_<source>` functions (one per dispatched command — search/get/refs as applicable). Keep arXiv and PubMed paths byte-identical for regression safety.
4. Add a section to this file with the same headings (Purpose, Endpoints used, Response format, Rate limits, Auth, Known gaps, Upstream docs).
5. Add a `tests/test_<source>.sh` smoke suite. Detect rate-limit (429) and skip rather than fail.
6. Update `README.md` Usage and CLI reference blocks; update `llms.txt` if the source affects LLM-agent behavior.
