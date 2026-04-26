Search and fetch arXiv papers as clean Markdown context for this conversation.

Usage: /paper7 <command> [args]

Commands:
  search <query>    — Search arXiv for papers
  get <id>          — Fetch a paper as Markdown and add to context
  repo <id>         — Find GitHub repos for a paper

Examples:
  /paper7 search "transformer architecture"
  /paper7 get 2401.04088
  /paper7 get 1706.03762 --no-refs

Instructions:

1. Parse the user's input to determine the command and arguments.

2. For "search": Run `paper7 search "<query>" --max 5` via Bash and show results. Ask which paper(s) the user wants to fetch.

3. For "get": Run `paper7 get <id> $ARGUMENTS` via Bash. The output is the full paper in Markdown. Summarize the key sections and tell the user the paper is now in context. If the user included a question, answer it using the paper content.

4. For "repo": Run `paper7 repo <id>` via Bash and show the results.

5. If no command is given, treat the input as a search query.

6. If paper7 is not installed, tell the user to install it:
   ```
   npm install -g @guataiba/paper7
   ```
