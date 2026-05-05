---
name: paper7-ask
description: Use when the user asks a research question that needs synthesized answers grounded in academic literature. Uses paper7 search, get, cite, and kb commands with a hard gate against fabricated citations.
---

# paper7-ask

Use paper7 to answer academic research questions with citation-grounded synthesis and local wiki file-back.

## Hard Gate

Never cite a DOI, arXiv ID, PMID, author, title, or year unless it appeared in direct `paper7` command output in this conversation.

## Workflow

1. Read prior wiki context with `paper7 kb read index`; if relevant, read pages with `paper7 kb read <slug>`.
2. Decompose the user question into 1-3 search queries.
3. Search with `paper7 search "<query>" --max 15` or `paper7 search "<query>" --source pubmed --max 15`.
4. Triage candidates with `paper7 get <id> --abstract-only`.
5. Ingest papers you will cite with `paper7 kb ingest <id>`.
6. Synthesize the answer with inline links to verified paper IDs only.
7. Generate bibliography entries with `paper7 cite <id> --format apa`.
8. Save the synthesis with `paper7 kb write <slug>`.

## Output

Give the answer, list consulted papers, and mention the wiki slug written.
