# paper7 tests

Shell-based smoke tests for `paper7` commands. They hit real upstream APIs
(arXiv, NCBI E-utilities), so network access is required.

## Run

```bash
# Run one test file
tests/test_pubmed_search.sh

# Run all tests
for t in tests/test_*.sh; do "$t" || exit $?; done
```

Each test script prints colored pass/fail lines and exits non-zero on failure
(exit code = number of failures).

## Conventions

- Test files are named `test_<feature>.sh`
- Every script is self-contained and idempotent — no shared state
- Tests prefer fast, specific queries to minimize upstream load
- Use `PAPER7` env var to override the CLI path if needed:
  ```bash
  PAPER7=/path/to/paper7.sh tests/test_pubmed_search.sh
  ```

## Current coverage

| File | Feature | Issue |
|---|---|---|
| `test_pubmed_search.sh` | `paper7 search --source pubmed` | #1 |
| `test_pubmed_get.sh` | `paper7 get pmid:NNN` + cache/list integration | #2 |
| `test_readme_docs.sh` | README + llms.txt document multi-source workflow | #3 |
