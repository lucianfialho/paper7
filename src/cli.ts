#!/usr/bin/env node

import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

export const VERSION = "0.6.0-beta.0"

const showHelp = Console.log(`paper7 v${VERSION} — arXiv papers as clean context for LLMs

Usage:
  paper7 <command> [options]

Commands:
  search <query>       Search papers by keyword (arXiv default; --source pubmed)
  get <id>             Fetch paper; compact header by default, full text with --detailed
                       id shapes: arXiv (YYMM.NNNNN), pmid:NNN, doi:10.XXXX/...
  refs <id>            List references of a paper via Semantic Scholar
  repo <id>            Find GitHub repositories for a paper
  list                 List cached papers in your KB
  cache clear [id]     Clear cache (all or specific paper)
  vault init <path>    Configure Obsidian-compatible vault path
  vault <id>           Export paper to vault as Obsidian-ready Markdown
  vault all            Export all cached papers to vault
  browse               Interactive picker over the local cache
  help                 Show this help

Options:
  --help, -h           Show help
  --version, -v        Show version

Examples:
  paper7 search "mixture of experts"
  paper7 search "psilocybin hypertension" --source pubmed --max 5
  paper7 get 2401.04088
  paper7 get 2401.04088 --detailed
  paper7 get 2401.04088 --detailed --range 35:67
  paper7 get 2401.04088 --no-refs
  paper7 get https://arxiv.org/abs/2401.04088
  paper7 repo 2401.04088
  paper7 list
  paper7 vault init ~/Documents/ArxivVault
  paper7 vault 2401.04088
  paper7 vault all
`)

const helpCommand = Command.make("help", {}, () => showHelp)

const mainCommand = Command.make("paper7", {}, () => showHelp).pipe(
  Command.withSubcommands([helpCommand])
)

const args = process.argv.slice(2).map((arg) => {
  if (arg === "-v") return "--version"
  if (arg === "--help" || arg === "-h") return "help"
  return arg
})

const program = Command.runWith(mainCommand, {
  version: VERSION,
})(args)

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)), {
  disableErrorReporting: true,
})
