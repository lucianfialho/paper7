#!/usr/bin/env node

import { Console, Effect } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Ar5ivClient, Ar5ivLive, type Ar5ivError } from "./ar5iv.js"
import { ArxivClient, ArxivLive, type ArxivError, type ArxivSearchResult } from "./arxiv.js"
import { CrossrefClient, CrossrefLive, type CrossrefError } from "./crossref.js"
import { getArxivPaper, getDoiPaper, getPubmedPaper, type GetError } from "./get.js"
import type { CliCommand } from "./parser.js"
import { parseCliArgs } from "./parser.js"
import { PubmedClient, PubmedLive, type PubmedError, type PubmedSearchResult } from "./pubmed.js"
import { getReferences, type RefsError } from "./refs.js"

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
  --source SOURCE      search only — arxiv (default) or pubmed
  --max N              Max search results / references (default: 10)
  --sort relevance|date  Sort search results (PubMed date uses NCBI pub date)
  --no-refs            Strip references section
  --no-cache           Force re-download
  --no-tldr            Skip TLDR enrichment in get
  --detailed           Emit full paper
  --range START:END    Detailed-only line slice
  --json               Emit raw JSON (refs only)
  --help, -h           Show help
  --version, -v        Show version

Examples:
  paper7 search "mixture of experts"
  paper7 search "psilocybin hypertension" --source pubmed --max 5 --sort date
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

const runCommand = (command: CliCommand): Effect.Effect<void, Error, ArxivClient | Ar5ivClient | PubmedClient | CrossrefClient> => {
  switch (command.tag) {
    case "help":
      return showHelp
    case "version":
      return Console.log(VERSION)
    case "search":
      if (command.source === "pubmed") {
        return PubmedClient.use((client) => client.search(command)).pipe(
          Effect.flatMap((result) => Console.log(renderPubmedSearch(command.query, command.max, result))),
          Effect.catch((error) =>
            Console.error(formatPubmedError(error)).pipe(Effect.andThen(Effect.fail(new Error(error.message))))
          )
        )
      }
      return ArxivClient.use((client) => client.search(command)).pipe(
        Effect.flatMap((result) => Console.log(renderArxivSearch(command.query, command.max, result))),
        Effect.catch((error) =>
          Console.error(formatArxivError(error)).pipe(Effect.andThen(Effect.fail(new Error(error.message))))
        )
      )
    case "get":
      return getPaper(command).pipe(
        Effect.flatMap((markdown) => Console.log(markdown)),
        Effect.catch((error) =>
          Console.error(formatGetError(error)).pipe(Effect.andThen(Effect.fail(new Error(formatGetError(error)))))
        )
      )
    case "refs":
      return getReferences(command).pipe(
        Effect.flatMap((output) => Console.log(output)),
        Effect.catch((error) =>
          Console.error(formatRefsError(error)).pipe(Effect.andThen(Effect.fail(new Error(formatRefsError(error)))))
        )
      )
    default:
      return Effect.fail(new Error(`not implemented: ${command.tag}`))
  }
}

const getPaper = (command: Extract<CliCommand, { readonly tag: "get" }>): Effect.Effect<string, GetError, ArxivClient | Ar5ivClient | PubmedClient | CrossrefClient> => {
  switch (command.id.tag) {
    case "arxiv":
      return getArxivPaper({
        id: command.id.id,
        cache: command.cache,
        refs: command.refs,
        tldr: command.tldr,
        detailed: command.detailed,
        range: command.range,
      })
    case "pubmed":
      return getPubmedPaper({
        id: command.id.id,
        cache: command.cache,
        refs: command.refs,
        tldr: command.tldr,
        detailed: command.detailed,
        range: command.range,
      })
    case "doi":
      return getDoiPaper({
        id: command.id.id,
        cache: command.cache,
        refs: command.refs,
        tldr: command.tldr,
        detailed: command.detailed,
        range: command.range,
      })
  }
}

export const renderPubmedSearch = (query: string, max: number, result: PubmedSearchResult): string => {
  if (result.total === 0) return `No papers found for: ${query}`

  const lines = [`Found ${result.total} papers (showing ${max}):`, ""]
  for (const warning of result.warnings) lines.push(warning)
  if (result.warnings.length > 0) lines.push("")

  for (const paper of result.papers) {
    const authors = truncateAuthors(paper.authors.join(", "))
    lines.push(`  [${paper.id}] ${paper.title}`)
    lines.push(`  ${authors} (${paper.published})`)
    lines.push("")
  }

  return lines.join("\n")
}

export const renderArxivSearch = (query: string, max: number, result: ArxivSearchResult): string => {
  if (result.total === 0) return `No papers found for: ${query}`

  const lines = [`Found ${result.total} papers (showing ${max}):`, ""]
  for (const warning of result.warnings) lines.push(warning)
  if (result.warnings.length > 0) lines.push("")

  for (const paper of result.papers) {
    const authors = truncateAuthors(paper.authors.join(", "))
    lines.push(`  [${paper.id}] ${paper.title}`)
    lines.push(`  ${authors} (${paper.published})`)
    lines.push("")
  }

  return lines.join("\n")
}

const truncateAuthors = (authors: string): string => {
  if (authors.length <= 60) return authors
  return `${authors.slice(0, 57)}...`
}

const formatArxivError = (error: ArxivError): string => {
  switch (error._tag) {
    case "ArxivHttpError":
      return `error: arXiv upstream failure: ${error.message}`
    case "ArxivTransientError":
      return `error: arXiv upstream failure: ${error.message}`
    case "ArxivTimeoutError":
      return `error: arXiv upstream failure: ${error.message}`
    case "ArxivDecodeError":
      return `error: arXiv decode failure: ${error.message}`
  }
}

const formatAr5ivError = (error: Ar5ivError): string => {
  switch (error._tag) {
    case "Ar5ivHttpError":
      return `error: ar5iv upstream failure: ${error.message}`
    case "Ar5ivTransientError":
      return `error: ar5iv upstream failure: ${error.message}`
    case "Ar5ivTimeoutError":
      return `error: ar5iv upstream failure: ${error.message}`
    case "Ar5ivDecodeError":
      return `error: ar5iv decode failure: ${error.message}`
  }
}

const formatGetError = (error: GetError): string => {
  switch (error._tag) {
    case "GetCacheReadError":
      return `error: cache failure: ${error.message}`
    case "GetCacheWriteError":
      return `error: cache failure: ${error.message}`
    case "GetRangeError":
      return `error: ${error.message}`
    case "GetArxivError":
      return formatArxivError(error.error)
    case "GetAr5ivError":
      return formatAr5ivError(error.error)
    case "GetPubmedError":
      return formatPubmedError(error.error)
    case "GetCrossrefError":
      return formatCrossrefError(error.error)
  }
}

const formatPubmedError = (error: PubmedError): string => {
  switch (error._tag) {
    case "PubmedHttpError":
      return `error: PubMed upstream failure: ${error.message}`
    case "PubmedTransientError":
      return `error: PubMed upstream failure: ${error.message}`
    case "PubmedTimeoutError":
      return `error: PubMed upstream failure: ${error.message}`
    case "PubmedDecodeError":
      return `error: PubMed decode failure: ${error.message}`
  }
}

const formatCrossrefError = (error: CrossrefError): string => {
  switch (error._tag) {
    case "CrossrefHttpError":
      return `error: Crossref upstream failure: ${error.message}`
    case "CrossrefTransientError":
      return `error: Crossref upstream failure: ${error.message}`
    case "CrossrefTimeoutError":
      return `error: Crossref upstream failure: ${error.message}`
    case "CrossrefDecodeError":
      return `error: Crossref decode failure: ${error.message}`
  }
}

const formatRefsError = (error: RefsError): string => {
  switch (error._tag) {
    case "RefsHttpError":
      return `error: Semantic Scholar failure: ${error.message}`
    case "RefsDecodeError":
      return `error: Semantic Scholar decode failure: ${error.message}`
  }
}

const parsed = parseCliArgs(process.argv.slice(2))

const program = parsed.ok
  ? runCommand(parsed.command)
  : Console.error(`error: ${parsed.error}`).pipe(Effect.andThen(Effect.fail(new Error(parsed.error))))

NodeRuntime.runMain(program.pipe(Effect.provide(ArxivLive), Effect.provide(Ar5ivLive), Effect.provide(PubmedLive), Effect.provide(CrossrefLive), Effect.provide(NodeServices.layer)), {
  disableErrorReporting: true,
})
