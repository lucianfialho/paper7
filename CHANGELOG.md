# Changelog

All notable changes to paper7 are documented here.

The format loosely follows [Keep a Changelog](https://keepachangelog.com).
Pre-1.0, minor versions may add features; breaking changes (if any) are called out explicitly.

## [0.3.0] — 2026-04-18

Semantic Scholar joins as a metadata-layer source. Real reference graph + TLDR enrichment for `paper7 get`. Establishes `docs/sources.md` as the per-source documentation home.

### Added

- **`paper7 refs <id>`** — lists references of a paper via Semantic Scholar's `/paper/{externalId}/references` endpoint. Accepts arXiv ID, arXiv URL, `pmid:NNN`, DOI, or S2 paperId. Output prefers `arxiv:` > `pmid:` > `doi:` > `s2:` for the printed prefix so the result chains cleanly into `paper7 get`. `--max N` (default 10), `--json` for raw S2 output.
- **TLDR enrichment in `paper7 get`** — both `arxiv` and `pmid:` paths now make one S2 call (`?fields=tldr`) and inject `**TLDR:** <text>` into the Markdown header when S2 has a TLDR for the paper. The TLDR is also written into `meta.json` so cache hits don't re-call S2. Best-effort: any failure (network, 404, 429, missing `jq`) silently omits the line; the core fetch never breaks because of enrichment.
- **`paper7 get --no-tldr`** — opt-out flag for offline use or when the user wants to skip the S2 call.
- **`docs/sources.md`** — new file documenting all three sources (arXiv, PubMed, Semantic Scholar) with a consistent template (Purpose, Endpoints, Response format, Rate limits, Auth, Known gaps, Upstream docs). Includes an "Adding a new source" template that establishes the pattern for bioRxiv/OpenAlex.
- New helpers in `paper7.sh`: `s2_check_jq`, `s2_paper_id_param`, `fetch_tldr` (best-effort, silent).

### Changed

- `paper7 get` now performs one extra HTTP call by default (Semantic Scholar TLDR lookup). Use `--no-tldr` to skip it.
- README Sources subsection adds a Semantic Scholar paragraph + pointer to `docs/sources.md`.
- README Usage block adds `paper7 refs` examples; CLI reference adds `refs` command and `--no-tldr` / `--json` options.

### Notes

- **`jq` becomes a hard dep for S2-using commands only** (`paper7 refs`, and the TLDR fetch inside `paper7 get`). Other commands stay pure curl/sed/awk. macOS Sequoia ships `jq` at `/usr/bin/jq`; brew/apt elsewhere.
- TLDR coverage is ~80% of papers indexed by S2. Already-cached papers from before this release won't get retrofit TLDRs; users wanting them must `paper7 cache clear <id>` and re-`get`.
- 5 of 8 S2 tests are skipped during heavy CI/dev iteration when the unauth rate limit (~100 req / 5min) trips. The skip-on-429 probe is the right behavior — better than fragile failures.

### Out of scope (planned follow-ups)

- `paper7 cites <id>` — reverse direction (papers citing a paper)
- `paper7 vault` consuming S2 refs instead of regex wikilinks
- Semantic Scholar search (`/paper/search`)
- API key flow for higher rate limits

## [0.2.1] — 2026-04-18

Interactive browser over the local KB. Small, focused release — no behavior change to fetch/search paths.

### Added

- **`paper7 browse`** — opens an fzf picker over the cached knowledge base (arXiv + PubMed combined). Preview pane shows the paper header and first 40 lines; Enter renders the full Markdown via `glow -p` (falls back to `less -R`, then `cat`). Esc exits cleanly.
- New helpers in `paper7.sh`: `list_browse_entries` (tab-separated cache enumeration) and `render_paper` (glow/less/cat fallback chain) — reusable by future commands.
- `PAPER7_NO_MAIN` env guard at the bottom of `paper7.sh` so test harnesses can `source` the script without triggering the CLI dispatcher.
- `tests/test_browse.sh` — 4 smoke assertions; full suite now 24/24.

### Notes

- `fzf` becomes a **hard dep for `paper7 browse` only**. All other commands stay pure curl/sed/awk/grep. A user who never runs `browse` never needs fzf.
- `glow` is recommended but optional — graceful fallback.
- README hero and "How it works" section already reflected multi-source in 0.2.0; README Usage + CLI reference add the `browse` line in this release.

## [0.2.0] — 2026-04-18

Multi-source and knowledge-graph release. Still pure bash, still zero deps beyond `curl/sed/grep/awk`.

### Added

- **PubMed as a second source.** `paper7 search "<query>" --source pubmed` queries NCBI E-utilities (esearch + esummary) and returns results in the same format as arXiv, with IDs prefixed `pmid:` to disambiguate. `--source arxiv` is the default so existing usage is unchanged. (#1, #4)
- **`paper7 get pmid:NNNNN`** fetches a PubMed abstract via NCBI efetch, converts the XML PubmedArticle to clean Markdown (title, authors, journal, publication date, DOI, abstract with labeled sections), and caches to `~/.paper7/cache/pmid-NNNNN/`. Works alongside arXiv papers in the same local KB. (#2, #5)
- **Obsidian vault export.** `paper7 vault init <path>` configures a vault directory; `paper7 vault <id>` and `paper7 vault all` emit Obsidian-compatible Markdown with YAML frontmatter (title, authors, arxiv_id, url, tags) and `[[arxiv_id]]` wikilinks resolved from the paper's references. Obsidian's native file watcher picks up the files — no plugin, no SDK. Papers you've fetched become an interactive citation graph.
- **`paper7 list`** now shows PubMed entries with the `pmid:` prefix alongside arXiv entries.
- **`paper7 cache clear pmid:NNNNN`** works for PubMed IDs in addition to arXiv.
- **`tests/` directory** with three smoke-test scripts hitting real upstream APIs (`test_pubmed_search.sh`, `test_pubmed_get.sh`, `test_readme_docs.sh`). Total 20 assertions.

### Changed

- `cmd_search` split into dispatcher + `cmd_search_arxiv` + `cmd_search_pubmed`; the arXiv path is byte-identical to 0.1.0.
- `cmd_get` split into dispatcher + `cmd_get_arxiv` + `cmd_get_pubmed`; new helpers `parse_pmid` and `is_pmid_input` route by prefix.
- README and `llms.txt` updated to document the multi-source workflow. (#3, #6)

### Fixed

- Internal `pipefail` robustness in `cmd_get_pubmed` — optional XML fields (Month, Day, DOI, Season-only PubDate) no longer abort the function when missing.

### Notes

- `paper7 vault` still rejects PubMed IDs in 0.2.0 — vault export for PMID papers is deferred to a future release once the PMID-specific frontmatter shape is designed.
- PubMed coverage is abstracts only. Full text via PMC is a separate pipeline and not included here.

## [0.1.0] — 2026-04-12

Initial release.

### Added

- `paper7 search` — search arXiv by keyword
- `paper7 get <id>` — fetch arXiv paper as clean Markdown via ar5iv HTML (skips PDF parsing entirely)
- `paper7 repo <id>` — extract GitHub repository URLs from a paper
- `paper7 list` / `paper7 cache clear` — manage the local knowledge base at `~/.paper7/cache/`
- Claude Code slash command + skills.sh package (paper7, paper7-research)
- Benchmark: 97% smaller than PDF, 86% smaller than raw HTML across 5 landmark papers

[0.3.0]: https://github.com/lucianfialho/paper7/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/lucianfialho/paper7/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lucianfialho/paper7/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lucianfialho/paper7/releases/tag/v0.1.0
