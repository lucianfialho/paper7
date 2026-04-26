#!/usr/bin/env node

import { Console, Effect, Option, Stdio } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { pathToFileURL } from "node:url"
import { Argument, CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/unstable/cli"
import { Ar5ivClient, Ar5ivLive, type Ar5ivError } from "./ar5iv.js"
import { ArxivClient, ArxivLive, type ArxivError, type ArxivSearchResult } from "./arxiv.js"
import { browseCachedPapers, type BrowseError } from "./browse.js"
import { CachePaths, CachePathsLive, clearCachedPapers, listCachedPapers, type CacheClearResult, type CacheError, type CacheListResult } from "./cache.js"
import { CrossrefClient, CrossrefLive, type CrossrefError } from "./crossref.js"
import { getArxivPaper, getDoiPaper, getPubmedPaper, type GetError } from "./get.js"
import type { CliCommand, PaperIdentifier, RangeSpec } from "./parser.js"
import { parsePaperIdentifier, parseRangeSpec } from "./parser.js"
import { PubmedClient, PubmedLive, type PubmedError, type PubmedSearchResult } from "./pubmed.js"
import { RepositoryDiscoveryClient, RepositoryDiscoveryLive, type RepositoryDiscoveryError, type RepositoryDiscoveryResult } from "./repo.js"
import { getReferences, type RefsError } from "./refs.js"
import { SemanticScholarClient, SemanticScholarLive, type SemanticScholarError } from "./semanticScholar.js"
import { exportAllPapersToVault, exportPaperToVault, initVault, type VaultError, type VaultExportAllResult, type VaultExportResult, type VaultInitResult, VaultPaths, VaultPathsLive } from "./vault.js"

export const VERSION = "0.6.0-beta.0"

const DEFAULT_MAX = 10
const SOURCE_CHOICES: ReadonlyArray<"arxiv" | "pubmed"> = ["arxiv", "pubmed"]
const SORT_CHOICES: ReadonlyArray<"relevance" | "date"> = ["relevance", "date"]

const showCommandHelp = (commandPath: ReadonlyArray<string>): Effect.Effect<void, CliError.ShowHelp> =>
  Effect.fail(new CliError.ShowHelp({ commandPath, errors: [] }))

const versionAlias = GlobalFlag.action({
  flag: Flag.boolean("paper7-version").pipe(
    Flag.withAlias("v"),
    Flag.withDescription("Show version information")
  ),
  run: (_, { command, version }) =>
    Effect.gen(function*() {
      const formatter = yield* CliOutput.Formatter
      yield* Console.log(formatter.formatVersion(command.name, version))
    })
})

const parseIdentifierEffect = (commandName: string, rawId: string): Effect.Effect<PaperIdentifier, Error> => {
  const id = parsePaperIdentifier(rawId)
  if (id !== undefined) return Effect.succeed(id)
  if (rawId.startsWith("pmid:")) return Effect.fail(new Error(`invalid PubMed ID: ${rawId}`))
  if (rawId.startsWith("doi:")) return Effect.fail(new Error(`invalid DOI: ${rawId}`))
  return Effect.fail(new Error(`${commandName} invalid paper id: ${rawId}`))
}

const parseRangeEffect = (rawRange: Option.Option<string>): Effect.Effect<RangeSpec | undefined, Error> => {
  if (Option.isNone(rawRange)) return Effect.succeed(undefined)
  const range = parseRangeSpec(rawRange.value)
  return range === undefined
    ? Effect.fail(new Error("invalid range: expected START:END"))
    : Effect.succeed(range)
}

const searchCommand = Command.make("search", {
  query: Argument.string("query").pipe(Argument.withDescription("Search query")),
  source: Flag.choice("source", SOURCE_CHOICES).pipe(
    Flag.withDefault("arxiv"),
    Flag.withDescription("Search source")
  ),
  max: Flag.integer("max").pipe(
    Flag.filterMap(
      (value) => Number.isSafeInteger(value) && value > 0 ? Option.some(value) : Option.none(),
      () => "--max requires a positive integer"
    ),
    Flag.withDefault(DEFAULT_MAX),
    Flag.withDescription("Maximum results")
  ),
  sort: Flag.choice("sort", SORT_CHOICES).pipe(
    Flag.withDefault("relevance"),
    Flag.withDescription("Sort order")
  )
}, (config) => runCommand({ tag: "search", query: config.query, source: config.source, max: config.max, sort: config.sort })).pipe(
  Command.withShortDescription("Search papers by keyword")
)

const getCommand = Command.make("get", {
  id: Argument.string("id").pipe(Argument.withDescription("arXiv, PubMed, or DOI identifier")),
  detailed: Flag.boolean("detailed").pipe(Flag.withDescription("Emit full paper")),
  range: Flag.string("range").pipe(Flag.optional, Flag.withDescription("Detailed-only line slice START:END")),
  noRefs: Flag.boolean("no-refs").pipe(Flag.withDescription("Strip references section")),
  noCache: Flag.boolean("no-cache").pipe(Flag.withDescription("Force re-download")),
  noTldr: Flag.boolean("no-tldr").pipe(Flag.withDescription("Skip TLDR enrichment"))
}, (config) =>
  Effect.gen(function*() {
    const id = yield* parseIdentifierEffect("get", config.id)
    const range = yield* parseRangeEffect(config.range)
    if (range !== undefined && !config.detailed) return yield* Effect.fail(new Error("--range requires --detailed"))
    yield* runCommand({
      tag: "get",
      id,
      detailed: config.detailed,
      range,
      refs: !config.noRefs,
      cache: !config.noCache,
      tldr: !config.noTldr
    })
  })).pipe(Command.withShortDescription("Fetch paper content"))

const refsCommand = Command.make("refs", {
  id: Argument.string("id").pipe(Argument.withDescription("Paper identifier")),
  max: Flag.integer("max").pipe(
    Flag.filterMap(
      (value) => Number.isSafeInteger(value) && value > 0 ? Option.some(value) : Option.none(),
      () => "--max requires a positive integer"
    ),
    Flag.withDefault(DEFAULT_MAX),
    Flag.withDescription("Maximum references")
  ),
  json: Flag.boolean("json").pipe(Flag.withDescription("Emit raw JSON"))
}, (config) =>
  Effect.gen(function*() {
    const id = yield* parseIdentifierEffect("refs", config.id)
    yield* runCommand({ tag: "refs", id, max: config.max, json: config.json })
  })).pipe(Command.withShortDescription("List references"))

const repoCommand = Command.make("repo", {
  id: Argument.string("id").pipe(Argument.withDescription("Paper identifier"))
}, (config) =>
  parseIdentifierEffect("repo", config.id).pipe(
    Effect.flatMap((id) => runCommand({ tag: "repo", id }))
  )).pipe(Command.withShortDescription("Find code repositories"))

const listCommand = Command.make("list", {}, () => runCommand({ tag: "list" })).pipe(
  Command.withShortDescription("List cached papers")
)

const cacheClearCommand = Command.make("clear", {
  id: Argument.string("id").pipe(Argument.optional, Argument.withDescription("Paper identifier"))
}, (config) =>
  Effect.gen(function*() {
    if (config.id._tag === "None") return yield* runCommand({ tag: "cache-clear" })
    const id = yield* parseIdentifierEffect("cache clear", config.id.value)
    yield* runCommand({ tag: "cache-clear", id })
  })).pipe(Command.withShortDescription("Clear cache"))

const cacheCommand = Command.make("cache", {}, () => showCommandHelp(["paper7", "cache"])).pipe(
  Command.withShortDescription("Manage cache"),
  Command.withSubcommands([cacheClearCommand])
)

const vaultInitCommand = Command.make("init", {
  path: Argument.string("path").pipe(Argument.withDescription("Vault path"))
}, (config) => runCommand({ tag: "vault-init", path: config.path })).pipe(
  Command.withShortDescription("Configure vault path")
)

const vaultAllCommand = Command.make("all", {}, () => runCommand({ tag: "vault-all" })).pipe(
  Command.withShortDescription("Export all cached papers")
)

const vaultCommand = Command.make("vault", {
  id: Argument.string("id").pipe(Argument.optional, Argument.withDescription("Paper identifier"))
}, (config) =>
  Effect.gen(function*() {
    if (config.id._tag === "None") return yield* showCommandHelp(["paper7", "vault"])
    const id = yield* parseIdentifierEffect("vault", config.id.value)
    yield* runCommand({ tag: "vault-export", id })
  })).pipe(
    Command.withShortDescription("Export papers to vault"),
    Command.withSubcommands([vaultInitCommand, vaultAllCommand])
  )

const browseCommand = Command.make("browse", {}, () => runCommand({ tag: "browse" })).pipe(
  Command.withShortDescription("Browse local cache")
)

const rootForHelp = Command.make("paper7", {}, () => showCommandHelp(["paper7"])).pipe(
  Command.withDescription("arXiv, PubMed, and DOI papers as clean context for LLMs"),
  Command.withSubcommands([
    searchCommand,
    getCommand,
    refsCommand,
    repoCommand,
    listCommand,
    cacheCommand,
    vaultCommand,
    browseCommand
  ]),
  Command.withGlobalFlags([versionAlias])
)

const showRootHelp = () => Command.runWith(rootForHelp, { version: VERSION })(["--help"])

const helpCommand = Command.make("help", {}, () => showRootHelp()).pipe(
  Command.withShortDescription("Show help")
)

export const rootCommand = Command.make("paper7", {}, () => showRootHelp()).pipe(
  Command.withDescription("arXiv, PubMed, and DOI papers as clean context for LLMs"),
  Command.withSubcommands([
    searchCommand,
    getCommand,
    refsCommand,
    repoCommand,
    listCommand,
    cacheCommand,
    vaultCommand,
    browseCommand,
    helpCommand
  ]),
  Command.withGlobalFlags([versionAlias])
)

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

const runCommand = (command: CliCommand): Effect.Effect<void, Error, ArxivClient | Ar5ivClient | PubmedClient | CrossrefClient | SemanticScholarClient | RepositoryDiscoveryClient | CachePaths | VaultPaths | Stdio.Stdio> => {
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
    case "repo":
      return RepositoryDiscoveryClient.use((client) => client.discover(command.id)).pipe(
        Effect.flatMap((result) => Console.log(renderRepositoryDiscovery(result))),
        Effect.catch((error) =>
          Console.error(formatRepositoryDiscoveryError(error)).pipe(Effect.andThen(Effect.fail(new Error(formatRepositoryDiscoveryError(error)))))
        )
      )
    case "list":
      return listCachedPapers().pipe(
        Effect.flatMap((result) => Console.log(renderCacheList(result))),
        Effect.catch((error) =>
          Console.error(formatCacheError(error)).pipe(Effect.andThen(Effect.fail(new Error(formatCacheError(error)))))
        )
      )
    case "cache-clear":
      return clearCachedPapers(command.id).pipe(
        Effect.flatMap((result) => Console.log(renderCacheClear(result))),
        Effect.catch((error) =>
          Console.error(formatCacheError(error)).pipe(Effect.andThen(Effect.fail(new Error(formatCacheError(error)))))
        )
      )
    case "vault-init":
      return initVault(command.path).pipe(
        Effect.flatMap((result) => Console.log(renderVaultInit(result))),
        Effect.catch((error) =>
          Console.error(formatVaultError(error)).pipe(Effect.andThen(Effect.fail(new Error(formatVaultError(error)))))
        )
      )
    case "vault-export":
      return exportPaperToVault(command.id).pipe(
        Effect.flatMap((result) => Console.log(renderVaultExport(result))),
        Effect.catch((error) =>
          Console.error(formatVaultError(error)).pipe(Effect.andThen(Effect.fail(new Error(formatVaultError(error)))))
        )
      )
    case "vault-all":
      return exportAllPapersToVault().pipe(
        Effect.flatMap((result) => Console.log(renderVaultExportAll(result))),
        Effect.catch((error) =>
          Console.error(formatVaultError(error)).pipe(Effect.andThen(Effect.fail(new Error(formatVaultError(error)))))
        )
      )
    case "browse":
      return browseCachedPapers().pipe(
        Effect.flatMap((result) => Console.log(result)),
        Effect.catch((error) =>
          Console.error(formatBrowseError(error)).pipe(Effect.andThen(Effect.fail(new Error(formatBrowseError(error)))))
        )
      )
    default:
      return Effect.fail(new Error("not implemented"))
  }
}

const getPaper = (command: Extract<CliCommand, { readonly tag: "get" }>): Effect.Effect<string, GetError, ArxivClient | Ar5ivClient | PubmedClient | CrossrefClient | SemanticScholarClient> => {
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

export const renderRepositoryDiscovery = (result: RepositoryDiscoveryResult): string => {
  const lines: Array<string> = [...result.warnings]
  if (result.candidates.length === 0) {
    if (lines.length > 0) lines.push("")
    lines.push("No repositories found")
    return lines.join("\n")
  }

  if (lines.length > 0) lines.push("")
  lines.push(`Found ${result.candidates.length} repository candidate${result.candidates.length === 1 ? "" : "s"}:`, "")
  for (const candidate of result.candidates) {
    const official = candidate.isOfficial === true ? " official" : ""
    const name = candidate.name === undefined ? "" : ` ${candidate.name}`
    lines.push(`  [${candidate.source}${official}]${name}`)
    lines.push(`  ${candidate.url}`)
    lines.push("")
  }
  return lines.join("\n")
}

export const renderCacheList = (result: CacheListResult): string => {
  const lines: Array<string> = [...result.warnings]
  if (result.entries.length === 0) {
    if (lines.length > 0) lines.push("")
    lines.push("No cached papers")
    return lines.join("\n")
  }

  if (lines.length > 0) lines.push("")
  lines.push(`Cached papers (${result.entries.length}):`, "")
  for (const entry of result.entries) {
    lines.push(`  [${entry.id}] ${entry.title}`)
    if (entry.authors !== undefined) lines.push(`  ${truncateAuthors(entry.authors)}`)
    if (entry.url !== undefined) lines.push(`  ${entry.url}`)
    lines.push("")
  }
  return lines.join("\n")
}

export const renderCacheClear = (result: CacheClearResult): string => {
  switch (result._tag) {
    case "cleared-all":
      return "Cleared paper7 cache"
    case "cleared-one":
      return `Cleared cache for ${result.id}`
    case "missing":
      return result.id === undefined ? "No paper7 cache found" : `No cache entry for ${result.id}`
  }
}

export const renderVaultInit = (result: VaultInitResult): string => `Configured vault: ${result.path}`

export const renderVaultExport = (result: VaultExportResult): string => `Exported ${result.id} to ${result.path}`

export const renderVaultExportAll = (result: VaultExportAllResult): string => `Exported ${result.count} papers to ${result.path}`

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
    case "RefsSemanticScholarError":
      return formatSemanticScholarError(error.error)
  }
}

const formatSemanticScholarError = (error: SemanticScholarError): string => {
  switch (error._tag) {
    case "SemanticScholarHttpError":
      return `error: Semantic Scholar failure: ${error.message}`
    case "SemanticScholarNotFoundError":
      return `error: ${error.message}`
    case "SemanticScholarRateLimitError":
      return error.retryAfter === undefined
        ? `error: Semantic Scholar rate limit exceeded`
        : `error: Semantic Scholar rate limit exceeded; retry after ${error.retryAfter}`
    case "SemanticScholarTransientError":
      return `error: Semantic Scholar upstream failure: ${error.message}`
    case "SemanticScholarTimeoutError":
      return `error: Semantic Scholar upstream failure: ${error.message}`
    case "SemanticScholarDecodeError":
      return `error: Semantic Scholar decode failure: ${error.message}`
  }
}

const formatRepositoryDiscoveryError = (error: RepositoryDiscoveryError): string => {
  switch (error._tag) {
    case "PapersWithCodeHttpError":
      return `error: Papers With Code failure: ${error.message}`
    case "PapersWithCodeRateLimitError":
      return error.retryAfter === undefined
        ? `error: Papers With Code rate limit exceeded`
        : `error: Papers With Code rate limit exceeded; retry after ${error.retryAfter}`
    case "PapersWithCodeTransientError":
      return `error: Papers With Code upstream failure: ${error.message}`
    case "PapersWithCodeTimeoutError":
      return `error: Papers With Code upstream failure: ${error.message}`
    case "PapersWithCodeDecodeError":
      return `error: Papers With Code decode failure: ${error.message}`
  }
}

const formatCacheError = (error: CacheError): string => {
  switch (error._tag) {
    case "CacheFsError":
      return `error: cache failure: ${error.message}`
  }
}

const formatBrowseError = (error: BrowseError): string => {
  switch (error._tag) {
    case "BrowseCacheError":
      return formatCacheError(error.error)
    case "BrowseInvalidSelection":
      return `error: ${error.message}`
    case "BrowseCacheMissing":
    case "BrowseCacheMalformed":
    case "BrowseIoError":
      return `error: ${error.message}`
  }
}

const formatVaultError = (error: VaultError): string => {
  switch (error._tag) {
    case "VaultConfigMissing":
    case "VaultInvalidPath":
    case "VaultCacheMissing":
    case "VaultCacheMalformed":
      return `error: vault export failed: ${error.message}`
    case "VaultFsError":
      return `error: vault export failed: ${error.message}`
  }
}

export const main = Command.run(rootCommand, { version: VERSION }).pipe(
  Effect.provide(ArxivLive),
  Effect.provide(Ar5ivLive),
  Effect.provide(PubmedLive),
  Effect.provide(CrossrefLive),
  Effect.provide(SemanticScholarLive),
  Effect.provide(RepositoryDiscoveryLive),
  Effect.provide(CachePathsLive),
  Effect.provide(VaultPathsLive),
  Effect.provide(NodeServices.layer)
)

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  NodeRuntime.runMain(main, { disableErrorReporting: true })
}
