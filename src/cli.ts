#!/usr/bin/env node

import { Console, Data, Effect, Option, Stdio } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Argument, CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/unstable/cli"
import { Ar5ivClient, Ar5ivLive, type Ar5ivError } from "./ar5iv.js"
import { ArxivClient, ArxivLive, type ArxivError } from "./arxiv.js"
import { CachePaths, CachePathsLive, type CacheError } from "./cache.js"
import { CliValidationError } from "./cliValidation.js"
import { CrossrefClient, CrossrefLive, type CrossrefError } from "./crossref.js"
import type { CitationError } from "./cite.js"
import type { GetError } from "./get.js"
import type { KbError } from "./kb.js"
import type { CliCommand, CitationFormat, PaperIdentifier, RangeSpec } from "./parser.js"
import { parsePaperIdentifier, parseRangeSpec } from "./parser.js"
import { PubmedClient, PubmedLive, type PubmedError } from "./pubmed.js"
import { RepositoryDiscoveryClient, RepositoryDiscoveryLive, type RepositoryDiscoveryError } from "./repo.js"
import type { RefsError } from "./refs.js"
import { SemanticScholarClient, SemanticScholarLive, type SemanticScholarError } from "./semanticScholar.js"
import { VaultPaths, VaultPathsLive, type VaultError } from "./vault.js"
import type { BrowseError } from "./browse.js"

export const VERSION = "0.6.0"

const DEFAULT_MAX = 10
const SOURCE_CHOICES: ReadonlyArray<"arxiv" | "pubmed"> = ["arxiv", "pubmed"]
const SORT_CHOICES: ReadonlyArray<"relevance" | "date"> = ["relevance", "date"]
const CITATION_FORMAT_CHOICES: ReadonlyArray<CitationFormat> = ["bibtex", "apa", "abnt"]

export type LazyCommandName =
  | "search"
  | "get"
  | "refs"
  | "cite"
  | "repo"
  | "cache"
  | "vault"
  | "browse"
  | "kb"

export class CommandLoadError extends Data.TaggedError("CommandLoadError")<{
  readonly command: LazyCommandName
  readonly message: string
  readonly cause: unknown
}> {}

export type CommandLoader<Module> = () => Effect.Effect<Module, CommandLoadError>

export type CommandLoaders = {
  readonly search: CommandLoader<Pick<typeof import("./commands/search.js"), "runSearchCommand">>
  readonly get: CommandLoader<Pick<typeof import("./commands/get.js"), "runGetCommand">>
  readonly refs: CommandLoader<Pick<typeof import("./commands/refs.js"), "runRefsCommand">>
  readonly cite: CommandLoader<Pick<typeof import("./commands/cite.js"), "runCiteCommand">>
  readonly repo: CommandLoader<Pick<typeof import("./commands/repo.js"), "runRepoCommand">>
  readonly cache: CommandLoader<Pick<typeof import("./commands/cache.js"), "runCacheCommand">>
  readonly vault: CommandLoader<Pick<typeof import("./commands/vault.js"), "runVaultCommand">>
  readonly browse: CommandLoader<Pick<typeof import("./commands/browse.js"), "runBrowseCommand">>
  readonly kb: CommandLoader<Pick<typeof import("./commands/kb.js"), "runKbCommand">>
}

const defaultSearchLoader: CommandLoaders["search"] = () =>
  Effect.tryPromise({
    try: () => import("./commands/search.js"),
    catch: (cause) => new CommandLoadError({ command: "search", message: "failed to load search command implementation", cause }),
  })

const defaultGetLoader: CommandLoaders["get"] = () =>
  Effect.tryPromise({
    try: () => import("./commands/get.js"),
    catch: (cause) => new CommandLoadError({ command: "get", message: "failed to load get command implementation", cause }),
  })

const defaultRefsLoader: CommandLoaders["refs"] = () =>
  Effect.tryPromise({
    try: () => import("./commands/refs.js"),
    catch: (cause) => new CommandLoadError({ command: "refs", message: "failed to load refs command implementation", cause }),
  })

const defaultCiteLoader: CommandLoaders["cite"] = () =>
  Effect.tryPromise({
    try: () => import("./commands/cite.js"),
    catch: (cause) => new CommandLoadError({ command: "cite", message: "failed to load cite command implementation", cause }),
  })

const defaultRepoLoader: CommandLoaders["repo"] = () =>
  Effect.tryPromise({
    try: () => import("./commands/repo.js"),
    catch: (cause) => new CommandLoadError({ command: "repo", message: "failed to load repo command implementation", cause }),
  })

const defaultCacheLoader: CommandLoaders["cache"] = () =>
  Effect.tryPromise({
    try: () => import("./commands/cache.js"),
    catch: (cause) => new CommandLoadError({ command: "cache", message: "failed to load cache command implementation", cause }),
  })

const defaultVaultLoader: CommandLoaders["vault"] = () =>
  Effect.tryPromise({
    try: () => import("./commands/vault.js"),
    catch: (cause) => new CommandLoadError({ command: "vault", message: "failed to load vault command implementation", cause }),
  })

const defaultBrowseLoader: CommandLoaders["browse"] = () =>
  Effect.tryPromise({
    try: () => import("./commands/browse.js"),
    catch: (cause) => new CommandLoadError({ command: "browse", message: "failed to load browse command implementation", cause }),
  })

const defaultKbLoader: CommandLoaders["kb"] = () =>
  Effect.tryPromise({
    try: () => import("./commands/kb.js"),
    catch: (cause) => new CommandLoadError({ command: "kb", message: "failed to load kb command implementation", cause }),
  })

const defaultLoaders: CommandLoaders = {
  search: defaultSearchLoader,
  get: defaultGetLoader,
  refs: defaultRefsLoader,
  cite: defaultCiteLoader,
  repo: defaultRepoLoader,
  cache: defaultCacheLoader,
  vault: defaultVaultLoader,
  browse: defaultBrowseLoader,
  kb: defaultKbLoader,
}

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

const parseIdentifierEffect = (commandName: string, rawId: string): Effect.Effect<PaperIdentifier, CliValidationError> => {
  const id = parsePaperIdentifier(rawId)
  if (id !== undefined) return Effect.succeed(id)
  if (rawId.startsWith("pmid:")) return Effect.fail(new CliValidationError({ message: `invalid PubMed ID: ${rawId}` }))
  if (rawId.startsWith("doi:")) return Effect.fail(new CliValidationError({ message: `invalid DOI: ${rawId}` }))
  return Effect.fail(new CliValidationError({ message: `${commandName} invalid paper id: ${rawId}` }))
}

const parseRangeEffect = (rawRange: Option.Option<string>): Effect.Effect<RangeSpec | undefined, CliValidationError> => {
  if (Option.isNone(rawRange)) return Effect.succeed(undefined)
  const range = parseRangeSpec(rawRange.value)
  return range === undefined
    ? Effect.fail(new CliValidationError({ message: "invalid range: expected START:END" }))
    : Effect.succeed(range)
}

export const makeRootCommand = (loaders?: Partial<CommandLoaders>) => {
  const mergedLoaders = { ...defaultLoaders, ...loaders }
  const runCommand = makeRunCommand(mergedLoaders)

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
    ),
    noCache: Flag.boolean("no-cache").pipe(Flag.withDescription("Force fresh search"))
  }, (config) => runCommand({ tag: "search", query: config.query, source: config.source, max: config.max, sort: config.sort, cache: !config.noCache })).pipe(
    Command.withShortDescription("Search papers by keyword"),
    Command.withDescription("Search for papers across arXiv or PubMed by keyword. Results are cached locally for fast repeat access. Use this when you need to discover papers but don't yet have an identifier.")
  )

  const getCommand = Command.make("get", {
    id: Argument.string("id").pipe(Argument.withDescription("arXiv, PubMed, or DOI identifier")),
    detailed: Flag.boolean("detailed").pipe(Flag.withDescription("Emit full paper")),
    range: Flag.string("range").pipe(Flag.optional, Flag.withDescription("Detailed-only line slice START:END")),
    noRefs: Flag.boolean("no-refs").pipe(Flag.withDescription("Strip references section")),
    noCache: Flag.boolean("no-cache").pipe(Flag.withDescription("Force re-download")),
    noTldr: Flag.boolean("no-tldr").pipe(Flag.withDescription("Skip TLDR enrichment")),
    abstractOnly: Flag.boolean("abstract-only").pipe(Flag.withDescription("Emit title, metadata, and abstract only"))
  }, (config) =>
    Effect.gen(function*() {
      const id = yield* parseIdentifierEffect("get", config.id)
      const range = yield* parseRangeEffect(config.range)
      if (range !== undefined && !config.detailed) return yield* new CliValidationError({ message: "--range requires --detailed" })
      yield* runCommand({
        tag: "get",
        id,
        detailed: config.detailed,
        range,
        refs: !config.noRefs,
        cache: !config.noCache,
        tldr: !config.noTldr,
        abstractOnly: config.abstractOnly
      })
    })).pipe(
      Command.withShortDescription("Fetch paper content"),
      Command.withDescription("Fetch and display paper content from arXiv, PubMed, or a DOI. Use --detailed for full paper text, --abstract-only for a quick summary, or --range to extract specific sections. Papers are cached locally after first fetch.")
    )

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
    })).pipe(
      Command.withShortDescription("List references"),
      Command.withDescription("List bibliographic references for a paper using Semantic Scholar. Use this to discover related work or build a citation graph. Results include titles, authors, and venues where available.")
    )

  const repoCommand = Command.make("repo", {
    id: Argument.string("id").pipe(Argument.withDescription("Paper identifier"))
  }, (config) =>
    parseIdentifierEffect("repo", config.id).pipe(
      Effect.flatMap((id) => runCommand({ tag: "repo", id }))
    )).pipe(
      Command.withShortDescription("Find code repositories"),
      Command.withDescription("Discover code repositories associated with a paper via Papers With Code. Use this when you want to reproduce results or explore the implementation of a paper.")
    )

  const citeCommand = Command.make("cite", {
    id: Argument.string("id").pipe(Argument.withDescription("Paper identifier")),
    format: Flag.choice("format", CITATION_FORMAT_CHOICES).pipe(
      Flag.withDefault("bibtex"),
      Flag.withDescription("Citation format")
    )
  }, (config) =>
    parseIdentifierEffect("cite", config.id).pipe(
      Effect.flatMap((id) => runCommand({ tag: "cite", id, format: config.format }))
    )).pipe(
      Command.withShortDescription("Format citation"),
      Command.withDescription("Generate a citation for a paper in BibTeX, APA, or ABNT format. Use this to quickly grab properly formatted references for your own papers or bibliographies.")
    )

  const listCommand = Command.make("list", {}, () => runCommand({ tag: "list" })).pipe(
    Command.withShortDescription("List cached papers"),
    Command.withDescription("List all papers currently cached locally. Use this to see what you have already fetched and avoid redundant downloads.")
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
    Command.withDescription("Manage the local paper cache. Use this to clear cached papers and free disk space, or to remove specific papers when you want to force a fresh download."),
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
      Command.withDescription("Export cached papers to a vault directory for long-term storage or syncing. First run `vault init` to set the vault path, then export individual papers or all cached papers at once."),
      Command.withSubcommands([vaultInitCommand, vaultAllCommand])
    )

  const browseCommand = Command.make("browse", {}, () => runCommand({ tag: "browse" })).pipe(
    Command.withShortDescription("Browse local cache"),
    Command.withDescription("Interactively browse and select papers from the local cache. Use this to quickly find and open papers you have previously fetched without remembering their identifiers.")
  )

  const kbIngestCommand = Command.make("ingest", {
    id: Argument.string("id").pipe(Argument.withDescription("Paper identifier"))
  }, (config) =>
    parseIdentifierEffect("kb ingest", config.id).pipe(
      Effect.flatMap((id) => runCommand({ tag: "kb-ingest", id }))
    )).pipe(Command.withShortDescription("Fetch paper into wiki sources"))

  const kbReadCommand = Command.make("read", {
    slug: Argument.string("slug").pipe(Argument.withDescription("Page slug, index, or log"))
  }, (config) => runCommand({ tag: "kb-read", slug: config.slug })).pipe(
    Command.withShortDescription("Read wiki page")
  )

  const kbWriteCommand = Command.make("write", {
    slug: Argument.string("slug").pipe(Argument.withDescription("Page slug"))
  }, (config) => runCommand({ tag: "kb-write", slug: config.slug })).pipe(
    Command.withShortDescription("Write wiki page from stdin")
  )

  const kbSearchCommand = Command.make("search", {
    pattern: Argument.string("pattern").pipe(Argument.withDescription("Search pattern"))
  }, (config) => runCommand({ tag: "kb-search", pattern: config.pattern })).pipe(
    Command.withShortDescription("Search wiki pages")
  )

  const kbListCommand = Command.make("list", {}, () => runCommand({ tag: "kb-list" })).pipe(
    Command.withShortDescription("List wiki pages and sources")
  )

  const kbStatusCommand = Command.make("status", {}, () => runCommand({ tag: "kb-status" })).pipe(
    Command.withShortDescription("Show wiki status")
  )

  const kbCommand = Command.make("kb", {}, () => showCommandHelp(["paper7", "kb"])).pipe(
    Command.withShortDescription("Manage local research wiki"),
    Command.withDescription("Manage a local research wiki for reading notes and paper summaries. Use `kb ingest` to pull papers into your wiki sources, `kb read` and `kb write` to maintain pages, and `kb search` to find notes across your knowledge base."),
    Command.withSubcommands([kbIngestCommand, kbReadCommand, kbWriteCommand, kbSearchCommand, kbListCommand, kbStatusCommand])
  )

  const rootForHelp = Command.make("paper7", {}, () => showCommandHelp(["paper7"])).pipe(
    Command.withDescription("arXiv, PubMed, and DOI papers as clean context for LLMs"),
    Command.withSubcommands([
      searchCommand,
      getCommand,
      refsCommand,
      citeCommand,
      repoCommand,
      listCommand,
      cacheCommand,
      vaultCommand,
      browseCommand,
      kbCommand
    ]),
    Command.withGlobalFlags([versionAlias])
  )

  const showRootHelp = () => Command.runWith(rootForHelp, { version: VERSION })(["--help"])

  const helpCommand = Command.make("help", {}, () => showRootHelp()).pipe(
    Command.withShortDescription("Show help")
  )

  return Command.make("paper7", {}, () => showRootHelp()).pipe(
    Command.withDescription("arXiv, PubMed, and DOI papers as clean context for LLMs"),
    Command.withSubcommands([
      searchCommand,
      getCommand,
      refsCommand,
      citeCommand,
      repoCommand,
      listCommand,
      cacheCommand,
      vaultCommand,
      browseCommand,
      kbCommand,
      helpCommand
    ]),
    Command.withGlobalFlags([versionAlias])
  )
}

export const rootCommand = makeRootCommand()

export type CliCommandError =
  | ArxivError
  | PubmedError
  | CommandLoadError
  | GetError
  | RefsError
  | CitationError
  | RepositoryDiscoveryError
  | CacheError
  | VaultError
  | BrowseError
  | KbError

const reportAndFail =
  <E>(format: (error: E) => string) =>
  (error: E): Effect.Effect<never, E> =>
    Console.error(format(error)).pipe(Effect.andThen(Effect.fail(error)))

function makeRunCommand(loaders: CommandLoaders) {
  return (command: CliCommand): Effect.Effect<void, CliCommandError, ArxivClient | Ar5ivClient | PubmedClient | CrossrefClient | SemanticScholarClient | RepositoryDiscoveryClient | CachePaths | VaultPaths | Stdio.Stdio> => {
    switch (command.tag) {
      case "search":
        return loaders.search().pipe(
          Effect.flatMap((module) => module.runSearchCommand(command)),
          Effect.catch((error: CommandLoadError | ArxivError | PubmedError | CacheError): Effect.Effect<never, CommandLoadError | ArxivError | PubmedError | CacheError> => {
            if (error._tag === "CommandLoadError") return reportAndFail(formatCommandLoadError)(error)
            return reportAndFail(formatSearchError)(error)
          })
        )
      case "get":
        return loaders.get().pipe(
          Effect.flatMap((module) => module.runGetCommand(command)),
          Effect.catch((error: CommandLoadError | GetError): Effect.Effect<never, CommandLoadError | GetError> => {
            if (error._tag === "CommandLoadError") return reportAndFail(formatCommandLoadError)(error)
            return reportAndFail(formatGetError)(error)
          })
        )
      case "refs":
        return loaders.refs().pipe(
          Effect.flatMap((module) => module.runRefsCommand(command)),
          Effect.catch((error: CommandLoadError | RefsError): Effect.Effect<never, CommandLoadError | RefsError> => {
            if (error._tag === "CommandLoadError") return reportAndFail(formatCommandLoadError)(error)
            return reportAndFail(formatRefsError)(error)
          })
        )
      case "cite":
        return loaders.cite().pipe(
          Effect.flatMap((module) => module.runCiteCommand(command)),
          Effect.catch((error: CommandLoadError | CitationError): Effect.Effect<never, CommandLoadError | CitationError> => {
            if (error._tag === "CommandLoadError") return reportAndFail(formatCommandLoadError)(error)
            return reportAndFail(formatCitationError)(error)
          })
        )
      case "repo":
        return loaders.repo().pipe(
          Effect.flatMap((module) => module.runRepoCommand(command)),
          Effect.catch((error: CommandLoadError | RepositoryDiscoveryError): Effect.Effect<never, CommandLoadError | RepositoryDiscoveryError> => {
            if (error._tag === "CommandLoadError") return reportAndFail(formatCommandLoadError)(error)
            return reportAndFail(formatRepositoryDiscoveryError)(error)
          })
        )
      case "list":
      case "cache-clear":
        return loaders.cache().pipe(
          Effect.flatMap((module) => module.runCacheCommand(command)),
          Effect.catch((error: CommandLoadError | CacheError): Effect.Effect<never, CommandLoadError | CacheError> => {
            if (error._tag === "CommandLoadError") return reportAndFail(formatCommandLoadError)(error)
            return reportAndFail(formatCacheError)(error)
          })
        )
      case "vault-init":
      case "vault-export":
      case "vault-all":
        return loaders.vault().pipe(
          Effect.flatMap((module) => module.runVaultCommand(command)),
          Effect.catch((error: CommandLoadError | VaultError): Effect.Effect<never, CommandLoadError | VaultError> => {
            if (error._tag === "CommandLoadError") return reportAndFail(formatCommandLoadError)(error)
            return reportAndFail(formatVaultError)(error)
          })
        )
      case "browse":
        return loaders.browse().pipe(
          Effect.flatMap((module) => module.runBrowseCommand(command)),
          Effect.catch((error: CommandLoadError | BrowseError): Effect.Effect<never, CommandLoadError | BrowseError> => {
            if (error._tag === "CommandLoadError") return reportAndFail(formatCommandLoadError)(error)
            return reportAndFail(formatBrowseError)(error)
          })
        )
      case "kb-ingest":
      case "kb-read":
      case "kb-write":
      case "kb-search":
      case "kb-list":
      case "kb-status":
        return loaders.kb().pipe(
          Effect.flatMap((module) => module.runKbCommand(command)),
          Effect.catch((error: CommandLoadError | KbError | GetError): Effect.Effect<never, CommandLoadError | KbError | GetError> => {
            if (error._tag === "CommandLoadError") return reportAndFail(formatCommandLoadError)(error)
            if (isGetError(error)) return reportAndFail(formatGetError)(error)
            return reportAndFail(formatKbError)(error)
          })
        )
    }
  }
}

const isGetError = (error: KbError | GetError): error is GetError => {
  switch (error._tag) {
    case "GetCacheReadError":
    case "GetCacheWriteError":
    case "GetRangeError":
    case "GetArxivError":
    case "GetAr5ivError":
    case "GetPubmedError":
    case "GetCrossrefError":
      return true
    case "KbIoError":
    case "KbInvalidSlug":
    case "KbGetError":
      return false
  }
}

const formatKbError = (error: KbError): string => {
  switch (error._tag) {
    case "KbIoError":
      return `error: ${error.message}`
    case "KbInvalidSlug":
      return `error: invalid wiki slug: ${error.slug}`
    case "KbGetError":
      return formatGetError(error.error)
  }
}

const formatCitationError = (error: CitationError): string => {
  switch (error._tag) {
    case "ArxivHttpError":
    case "ArxivTransientError":
    case "ArxivTimeoutError":
    case "ArxivDecodeError":
      return formatArxivError(error)
    case "CrossrefHttpError":
    case "CrossrefTransientError":
    case "CrossrefTimeoutError":
    case "CrossrefDecodeError":
      return formatCrossrefError(error)
    case "PubmedHttpError":
    case "PubmedTransientError":
    case "PubmedTimeoutError":
    case "PubmedDecodeError":
      return formatPubmedError(error)
  }
}

const formatCommandLoadError = (error: CommandLoadError): string =>
  `error: failed to load ${error.command} command implementation: ${error.message}`

const formatSearchError = (error: ArxivError | PubmedError | CacheError): string => {
  switch (error._tag) {
    case "ArxivHttpError":
    case "ArxivTransientError":
    case "ArxivTimeoutError":
    case "ArxivDecodeError":
      return formatArxivError(error)
    case "PubmedHttpError":
    case "PubmedTransientError":
    case "PubmedTimeoutError":
    case "PubmedDecodeError":
      return formatPubmedError(error)
    case "CacheFsError":
      return formatCacheError(error)
  }
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

NodeRuntime.runMain(main, { disableErrorReporting: true })
