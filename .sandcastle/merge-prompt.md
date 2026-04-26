Merge branch {{BRANCH}} into the current branch for issue {{ISSUE_FILE}}.

Issue body:

{{ISSUE_BODY}}

Steps:

- Run `git merge {{BRANCH}} --no-edit`.
- If there are conflicts, resolve them correctly by reading both sides.
- Run the relevant tests/build.
- If tests fail, fix them before finishing.
- Commit the completed merge if Git requires a commit.
- When complete, output {{COMPLETION_SIGNAL}}.
