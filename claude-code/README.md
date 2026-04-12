# paper7 for Claude Code

Use paper7 as a slash command inside Claude Code.

## Install

1. Make sure paper7 CLI is installed:
```bash
curl -sSL https://raw.githubusercontent.com/lucianfialho/paper7/main/install.sh | bash
```

2. Copy the command to your project or global commands:

```bash
# For a specific project
mkdir -p .claude/commands
cp paper7.md .claude/commands/

# Or globally (available in all projects)
mkdir -p ~/.claude/commands
cp paper7.md ~/.claude/commands/
```

## Usage

Inside Claude Code:

```
/paper7 search "attention mechanism"
/paper7 get 2401.04088
/paper7 get 1706.03762 --no-refs
/paper7 repo 2401.04088
```

Or just:

```
/paper7 transformer architecture
```

This will search arXiv, let you pick papers, fetch them as clean Markdown, and add them directly to your conversation context.
