---
name: paper7-ask
description: Use when the user asks a research question that needs synthesized
  answers grounded in academic literature. Performs deep research using paper7
  primitives — checks the local KB first, searches arXiv/PubMed/Crossref for
  new sources, ingests them into the KB, synthesizes a citation-grounded
  markdown answer, and files the synthesis back as a wiki page so future
  questions compound. Hard gate against fabricated citations.
---

# paper7-ask — Deep Research from a Single Question

Turn a natural-language research question into a citation-grounded markdown
answer, using paper7 as the substrate for academic search and the local KB as
compounding memory.

## When to use

Trigger this skill when the user asks a question that needs evidence from
academic literature:
- *"What makes X work / fail / behave this way?"*
- *"Compare A and B for purpose Y"*
- *"What's the state of the art on Z?"*
- *"Is approach X supported by research?"*

Do NOT trigger for casual questions, general programming help, or topics with
no academic literature.

## HARD-GATE — citation integrity

You MUST NEVER cite a DOI, arXiv ID, or paper that has not appeared in the
direct output of a paper7 command in this conversation. If you cannot trace
a claim back to a paper7 output, either remove the claim or run paper7
search/get to find real supporting evidence. Fabricated citations are the
single failure mode this skill exists to prevent — treat the gate as
non-negotiable.

## Pipeline

Execute these steps IN ORDER. Each step is a TodoWrite task.

### 0. KB check

Read the local KB before searching externally:

```bash
paper7 kb read index
```

Look for pages whose slug or summary matches the question topic. If a
relevant page exists:

```bash
paper7 kb read <slug>
```

If the existing synthesis already answers the question, skip to step 6
and use the existing page as the answer foundation. Otherwise, treat the
existing page as prior context and continue to step 1 to supplement it.

### 1. Decompose the question

Rewrite the user's question as 1-3 searchable sub-queries. Example:

> *"What makes the Pitohui bird toxic?"*
> →
> - "pitohui bird toxicity batrachotoxin"
> - "pitohui dietary source neurotoxin"
> - "batrachotoxin sodium channel mechanism"

Print the sub-queries to the user before searching.

### 2. Search

For each sub-query, choose the source by inferred domain:
- CS/physics/math/AI → `paper7 search "<query>" --max 15` (arXiv default)
- Biomedicine → `paper7 search "<query>" --source pubmed --max 15`
- Specific DOI mentioned by user → `paper7 get doi:<doi>` directly

Collect search results across sub-queries.

### 3. Triage

Read titles and abstracts from search output. Pick the top 5-10 papers most
relevant to the original question. For each pick, note one-line justification.
For each rejected, one-line dismissal.

For papers already in `kb sources/` (visible from step 0 KB check), skip
re-fetching — read directly via `paper7 kb read <existing-slug>` if the
content is summarized, or load from `~/.paper7/wiki/sources/` if you need the
raw source.

### 4. Read

For each paper that survived triage (your top picks — the ones you commit to
citing in the synthesis):

- **Default — `paper7 kb ingest <id>`.** Fetches full text AND persists
  into `~/.paper7/wiki/sources/`. Use this for every paper you plan to
  cite. Sources are corpus that compounds — future questions on adjacent
  topics will reach back into them via step 0. If you only `--abstract-only`,
  the corpus stays empty and the next session re-fetches everything.
- **Exception — `paper7 get <id> --abstract-only`.** Use ONLY when you
  are still triaging and not yet sure a paper belongs in top picks. The flag
  exists for borderline candidates, not for the papers you've already
  decided to use.

Rule of thumb: if the paper appears in your bibliography at the end, it
must have been ingested in this step. No exceptions.

Extract 1-3 quotes per paper, each tagged with the paper identifier.

### 5. Synthesize

Compose a markdown answer with:
- A short direct answer at the top (2-4 sentences).
- Sections by aspect/mechanism/timeline as appropriate.
- Inline citations as `[Author et al., Year](https://doi.org/<doi>)`. Use
  arXiv shortlink `[Author, Year](https://arxiv.org/abs/<id>)` when DOI
  unknown.
- A bibliography section at the bottom.

### 6. Validate (HARD-GATE checkpoint)

Before showing the answer to the user, walk through every factual claim and
verify it traces back to a paper7 output in this session. For any claim
without provenance:
- Either remove the claim entirely
- Or run `paper7 search` / `paper7 get` to find real supporting evidence
  and update the citation

DO NOT proceed to step 7 unless every claim is grounded.

### 7. Cite

Generate the bibliography for each paper consumed:

```bash
paper7 cite <id> --format apa
```

Append the formatted citations to the bibliography section.

### 8. File-back

Save the synthesis as a wiki page so future questions can build on it:

```bash
echo "<the synthesized markdown>" | paper7 kb write <slug>
```

**Slug convention:** kebab-case derived from the topic (intent), not the
literal question. Examples:
- *"What makes the Pitohui bird toxic?"* → `pitohui-toxicity`
- *"LoRA vs full fine-tuning"* → `lora-vs-full-finetuning`

If the slug already exists in `paper7 kb read index`, decide:
- Complement: `paper7 kb read <slug>`, edit the content, `paper7 kb write
  <slug>`.
- Variant: use a more specific slug (e.g. `pitohui-toxicity-mechanism`).

`paper7 kb write` auto-updates the root `index.md` (replaces or appends
the row for this slug) and appends a parseable log entry to `log.md`.
Do not write index/log manually — and do not pass `index` or `log` as a
slug; paper7 rejects those as reserved.

## Output to the user

Print the synthesized markdown answer to the conversation. Mention briefly:
- How many papers were consulted.
- Whether prior KB pages were used.
- The slug under which the synthesis was filed (so the user can read it
  directly later via `paper7 kb read <slug>`).

## Failure modes and recovery

- **`paper7 search` returns empty:** reformulate the sub-query (broader
  terms, different domain). If still empty after 2 attempts, tell the user
  honestly — paper7 cannot find supporting literature.
- **`paper7 get` fails with HTTP error:** retry once. If still fails, drop
  that paper from the top picks and continue with others.
- **DOI without abstract:** Crossref doesn't always have abstracts; the
  paper7 command will warn. Pick a different paper or use the title +
  metadata only.
- **No DOIs at all (rare):** use arXiv ID or PMID as the citation
  identifier. `paper7 cite` handles all three.

## Anti-patterns

| Pattern | Problem |
|---------|---------|
| Citing a DOI you remember from training | HARD-GATE violation. Cite only paper7 outputs. |
| Reading 20+ papers | Token bloat. 5-10 is the right range. |
| Skipping step 0 (KB check) | Wastes search calls and discards prior synthesis. |
| Skipping step 8 (file-back) | Loses the synthesis. Future questions start over. |
| Using `--abstract-only` for top picks | Sources stay empty, corpus never compounds. Default to `kb ingest`. |
| Slug = literal question | `pitohui-toxicity` not `what-makes-the-pitohui-bird-toxic`. |
| Inventing a year/author when metadata is missing | Use the real metadata or omit the field. |
