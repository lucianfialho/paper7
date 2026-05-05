# paper7 tests

Default test path: `bun run test` runs the deterministic `@effect/vitest` suite. Default tests use fake services, fixtures, `Command.runWith`, and Effect test services; they must not require network access.

## Run

```bash
bun run test
```

Run narrow suites directly with Vitest paths when iterating:

```bash
bun run test -- tests/search.test.ts
```

## Opt-In Checks

Live upstream checks are not part of the default suite. Add explicit Vitest suites or ad-hoc local commands for deliberate upstream checks; do not add them to `bun run test` or default CI.

## Migration Matrix

| Former shell scenario | Deterministic replacement |
| --- | --- |
| CLI skeleton | `tests/cli-skeleton.test.ts` covers root help/version, app-level stdio, and package metadata checks. |
| Typed CLI boundary | `tests/cli-skeleton.test.ts`, command suites using `Command.runWith`, and domain parser coverage in command tests. |
| arXiv search | `tests/search.test.ts` uses fake arXiv clients and decode-error fixtures. |
| PubMed search | `tests/search.test.ts` uses fake PubMed clients and decode-error fixtures. |
| arXiv get | `tests/get.test.ts` uses fake arXiv, ar5iv, cache, render, and Semantic Scholar services. |
| PubMed get | `tests/get.test.ts` uses fake PubMed, cache, render, and Semantic Scholar services. |
| DOI get | `tests/get.test.ts` uses fake Crossref and DOI render coverage. |
| get modes | `tests/get.test.ts` covers compact, detailed, range, no refs, cache, and TLDR modes. |
| abstract-only | `tests/get.test.ts` covers arXiv, PubMed, and DOI abstract-only output without full-text fetch. |
| refs | `tests/refs-repo.test.ts` uses fake Semantic Scholar services and JSON output assertions. |
| repo | `tests/refs-repo.test.ts` uses fake repository discovery services. |
| cite | `tests/cite.test.ts` uses fake arXiv, PubMed, and Crossref services for citation output. |
| cache | `tests/cache.test.ts` uses temporary filesystem coverage for list and clear behavior. |
| vault | `tests/vault.test.ts` uses temporary filesystem coverage for config and export behavior. |
| browse | `tests/browse.test.ts` uses test stdin/stdout and fake cache entries. |
| kb | `tests/kb.test.ts` covers local wiki read, list, status, search, and ingest paths. |
| README docs | `tests/docs-hardening.test.ts` checks npm/npx install docs and unsafe installer removal. |
| release hardening | `tests/package-hardening.test.ts` checks publish surface, dependency allowlist, install hooks, and default test command. |
| Semantic Scholar | `tests/refs-repo.test.ts` and `tests/get.test.ts` cover references, TLDR, rate limits, retries, and typed errors with fake clients. |
