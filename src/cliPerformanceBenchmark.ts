import { Console, Data, Effect, Option, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import { pathToFileURL } from "node:url"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { normalizeSearchQuery, SEARCH_CACHE_TTL_MS } from "./searchCache.js"
import { createHash } from "node:crypto"

export type CliPerfVariant =
  | { readonly tag: "local-built" }
  | { readonly tag: "local-bun" }
  | { readonly tag: "installed"; readonly path: string }

export type CliPerfScenario =
  | { readonly tag: "startup-version" }
  | { readonly tag: "cached-get"; readonly arxivId: string }
  | { readonly tag: "cache-list" }
  | { readonly tag: "arxiv-search-cold"; readonly query: string }
  | { readonly tag: "arxiv-search-warm"; readonly query: string }
  | { readonly tag: "pubmed-search-cold"; readonly query: string }
  | { readonly tag: "pubmed-search-warm"; readonly query: string }

export type CliPerfCommand = {
  readonly label: string
  readonly command: string
}

export type CliPerfPlan = {
  readonly cacheHome: string
  readonly commands: ReadonlyArray<CliPerfCommand>
}

export class CliPerfBenchmarkError extends Data.TaggedError("CliPerfBenchmarkError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const defaultArxivId = "2401.04088"

const variantLabel = (variant: CliPerfVariant): string => {
  switch (variant.tag) {
    case "local-built": return "local-built"
    case "local-bun": return "local-bun"
    case "installed": return "installed"
  }
}

const variantBinary = (variant: CliPerfVariant): string => {
  switch (variant.tag) {
    case "local-built": return "node dist/cli.js"
    case "local-bun": return "bun src/cli.ts"
    case "installed": return variant.path
  }
}

const scenarioLabel = (scenario: CliPerfScenario): string => {
  switch (scenario.tag) {
    case "startup-version": return "startup-version"
    case "cached-get": return `cached-get-${scenario.arxivId}`
    case "cache-list": return "cache-list"
    case "arxiv-search-cold": return `arxiv-search-cold-${scenario.query.replace(/\s+/g, "-")}`
    case "arxiv-search-warm": return `arxiv-search-warm-${scenario.query.replace(/\s+/g, "-")}`
    case "pubmed-search-cold": return `pubmed-search-cold-${scenario.query.replace(/\s+/g, "-")}`
    case "pubmed-search-warm": return `pubmed-search-warm-${scenario.query.replace(/\s+/g, "-")}`
  }
}

const scenarioArgs = (scenario: CliPerfScenario, variant: CliPerfVariant): ReadonlyArray<string> => {
  switch (scenario.tag) {
    case "startup-version": return ["--version"]
    case "cached-get": return ["get", scenario.arxivId, "--detailed"]
    case "cache-list": return ["list"]
    case "arxiv-search-cold":
      return variant.tag === "installed"
        ? ["search", scenario.query, "--source", "arxiv", "--max", "5", "--sort", "relevance"]
        : ["search", scenario.query, "--source", "arxiv", "--max", "5", "--sort", "relevance", "--no-cache"]
    case "arxiv-search-warm": return ["search", scenario.query, "--source", "arxiv", "--max", "5", "--sort", "relevance"]
    case "pubmed-search-cold":
      return variant.tag === "installed"
        ? ["search", scenario.query, "--source", "pubmed", "--max", "5", "--sort", "relevance"]
        : ["search", scenario.query, "--source", "pubmed", "--max", "5", "--sort", "relevance", "--no-cache"]
    case "pubmed-search-warm": return ["search", scenario.query, "--source", "pubmed", "--max", "5", "--sort", "relevance"]
  }
}

const scenarioUsesCacheHome = (scenario: CliPerfScenario): boolean => {
  switch (scenario.tag) {
    case "startup-version": return false
    case "cached-get": return true
    case "cache-list": return true
    case "arxiv-search-cold": return true
    case "arxiv-search-warm": return true
    case "pubmed-search-cold": return true
    case "pubmed-search-warm": return true
  }
}

export const buildCliPerfPlan = (input: {
  readonly cacheHome: string
  readonly installedPaper7?: string
}): CliPerfPlan => {
  const variants: Array<CliPerfVariant> = [
    { tag: "local-built" },
    { tag: "local-bun" }
  ]

  if (input.installedPaper7 !== undefined) {
    variants.push({ tag: "installed", path: input.installedPaper7 })
  }

  const scenarios: Array<CliPerfScenario> = [
    { tag: "startup-version" },
    { tag: "cached-get", arxivId: defaultArxivId },
    { tag: "cache-list" },
    { tag: "arxiv-search-cold", query: "mixture of experts" },
    { tag: "arxiv-search-warm", query: "mixture of experts" },
    { tag: "pubmed-search-cold", query: "heart failure" },
    { tag: "pubmed-search-warm", query: "heart failure" }
  ]

  const commands: Array<CliPerfCommand> = []

  for (const variant of variants) {
    for (const scenario of scenarios) {
      const label = `${variantLabel(variant)}--${scenarioLabel(scenario)}`
      const binary = variantBinary(variant)
      const args = scenarioArgs(scenario, variant)

      if (scenarioUsesCacheHome(scenario)) {
        commands.push({
          label,
          command: `env HOME=${quoteShell(input.cacheHome)} ${binary} ${args.map(quoteShell).join(" ")}`
        })
      } else {
        commands.push({
          label,
          command: `${binary} ${args.map(quoteShell).join(" ")}`
        })
      }
    }
  }

  return { cacheHome: input.cacheHome, commands }
}

export const renderHyperfineArgs = (plan: CliPerfPlan): ReadonlyArray<string> => {
  const args: Array<string> = []
  for (const cmd of plan.commands) {
    args.push("--command-name", cmd.label, cmd.command)
  }
  return args
}

export const seedCachedPaper = (cacheHome: string): Effect.Effect<void, CliPerfBenchmarkError> =>
  Effect.gen(function*() {
    const cacheDir = join(cacheHome, ".paper7", "cache", defaultArxivId)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(cacheDir, { recursive: true })
        await writeFile(join(cacheDir, "paper.md"), cachedPaperFixture, { encoding: "utf8" })
        await writeFile(
          join(cacheDir, "meta.json"),
          JSON.stringify({
            id: defaultArxivId,
            title: "Benchmark Fixture Paper",
            authors: "Ada Lovelace, Grace Hopper",
            url: "https://arxiv.org/abs/2401.04088"
          }),
          { encoding: "utf8" }
        )
      },
      catch: (cause): CliPerfBenchmarkError =>
        new CliPerfBenchmarkError({ message: "failed to seed cached paper", cause })
    })
  })

const searchCacheKey = (source: string, query: string, max: number, sort: string): string => {
  const normalized = normalizeSearchQuery(query)
  const hash = createHash("sha256")
  hash.update(source)
  hash.update(normalized)
  hash.update(String(max))
  hash.update(sort)
  return hash.digest("hex")
}

export const seedCachedArxivSearch = (cacheHome: string): Effect.Effect<void, CliPerfBenchmarkError> =>
  Effect.gen(function*() {
    const cacheRoot = join(cacheHome, ".paper7", "cache")
    const query = "mixture of experts"
    const max = 5
    const sort = "relevance"
    const key = searchCacheKey("arxiv", query, max, sort)
    const dir = join(cacheRoot, "search", "arxiv")
    const path = join(dir, `${key}.json`)
    const envelope = {
      createdAt: Date.now(),
      ttlMs: SEARCH_CACHE_TTL_MS,
      params: {
        source: "arxiv",
        normalizedQuery: normalizeSearchQuery(query),
        max,
        sort
      },
      payload: {
        total: 1,
        papers: [
          {
            id: "2401.04088",
            title: "Benchmark Search Paper",
            authors: ["Ada Lovelace"],
            published: "2024-01-08"
          }
        ],
        warnings: []
      }
    }
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(path, JSON.stringify(envelope), { encoding: "utf8" })
      },
      catch: (cause): CliPerfBenchmarkError =>
        new CliPerfBenchmarkError({ message: "failed to seed cached arXiv search", cause })
    })
  })

export const seedCachedPubmedSearch = (cacheHome: string): Effect.Effect<void, CliPerfBenchmarkError> =>
  Effect.gen(function*() {
    const cacheRoot = join(cacheHome, ".paper7", "cache")
    const query = "heart failure"
    const max = 5
    const sort = "relevance"
    const key = searchCacheKey("pubmed", query, max, sort)
    const dir = join(cacheRoot, "search", "pubmed")
    const path = join(dir, `${key}.json`)
    const envelope = {
      createdAt: Date.now(),
      ttlMs: SEARCH_CACHE_TTL_MS,
      params: {
        source: "pubmed",
        normalizedQuery: normalizeSearchQuery(query),
        max,
        sort
      },
      payload: {
        total: 1,
        papers: [
          {
            id: "pmid:38903003",
            title: "Benchmark PubMed Search Paper",
            authors: ["Ada Lovelace"],
            published: "2024"
          }
        ],
        warnings: []
      }
    }
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(path, JSON.stringify(envelope), { encoding: "utf8" })
      },
      catch: (cause): CliPerfBenchmarkError =>
        new CliPerfBenchmarkError({ message: "failed to seed cached PubMed search", cause })
    })
  })

export const checkHyperfineAvailable = (): Effect.Effect<boolean, never, ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make`sh -c ${"command -v hyperfine"}`)
      const exitCode = yield* handle.exitCode
      return exitCode === 0
    }).pipe(Effect.catch(() => Effect.succeed(false)))
  )

export const runCliPerfBenchmark = (): Effect.Effect<
  void,
  CliPerfBenchmarkError,
  ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    const hasHyperfine = yield* checkHyperfineAvailable()
    if (!hasHyperfine) {
      yield* new CliPerfBenchmarkError({ message: "hyperfine is not installed; install it to run CLI performance benchmarks" })
      return
    }

    const distExists = yield* fs.exists("dist/cli.js").pipe(
      Effect.catch(() => Effect.succeed(false))
    )
    if (!distExists) {
      yield* new CliPerfBenchmarkError({ message: "dist/cli.js not found; run `bun run build` first" })
      return
    }

    const cacheHome = yield* Effect.promise(() =>
      import("node:os").then((os) => os.tmpdir()).then((tmp) => `${tmp}/paper7-cli-perf-${Date.now()}`)
    )

    yield* seedCachedPaper(cacheHome)
    yield* seedCachedArxivSearch(cacheHome)
    yield* seedCachedPubmedSearch(cacheHome)

    const installedPath = yield* findInstalledPaper7()
    const plan = buildCliPerfPlan({ cacheHome, installedPaper7: Option.getOrUndefined(installedPath) })

    if (plan.commands.length === 0) {
      yield* new CliPerfBenchmarkError({ message: "no benchmark commands to run" })
      return
    }

    const hyperfineArgs = renderHyperfineArgs(plan)
    const args = ["--warmup", "3", "--ignore-failure", ...hyperfineArgs]

    yield* Console.log(`Running CLI performance benchmark (${plan.commands.length} commands)...`)

    yield* Effect.scoped(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const command = ChildProcess.make`hyperfine ${args}`
        const handle = yield* spawner.spawn(command)

        const [stdoutChunks, stderrChunks] = yield* Effect.all(
          [
            Stream.runCollect(handle.stdout.pipe(Stream.decodeText())),
            Stream.runCollect(handle.stderr.pipe(Stream.decodeText()))
          ],
          { concurrency: 2 }
        )

        const stdout = stdoutChunks.join("")
        const stderr = stderrChunks.join("")

        yield* Console.log(stdout)
        if (stderr.length > 0) {
          yield* Console.error(stderr)
        }

        const exitCode = yield* handle.exitCode
        if (exitCode !== 0) {
          yield* new CliPerfBenchmarkError({
            message: `hyperfine exited with code ${exitCode}`,
            cause: { stderr }
          })
          return
        }

        yield* Console.log("CLI performance benchmark complete.")
      })
    ).pipe(
      Effect.catch((cause): Effect.Effect<void, CliPerfBenchmarkError> =>
        Effect.fail(new CliPerfBenchmarkError({ message: "benchmark runner failed", cause }))
      )
    )
  })

const findInstalledPaper7 = (): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make`sh -c ${"command -v paper7"}`)
      const stdoutChunks = yield* Stream.runCollect(handle.stdout.pipe(Stream.decodeText()))
      const exitCode = yield* handle.exitCode
      const path = stdoutChunks.join("").trim()
      if (exitCode === 0 && path.length > 0) {
        return Option.some(path)
      }
      return Option.none()
    }).pipe(Effect.catch(() => Effect.succeed(Option.none())))
  )

const quoteShell = (input: string): string => {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(input)) return input
  return `"${input.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`
}

const cachedPaperFixture = `# Benchmark Fixture Paper

**Authors:** Ada Lovelace, Grace Hopper
**arXiv:** https://arxiv.org/abs/2401.04088

---

This is a minimal fixture paper for CLI performance benchmarking.
It exists only to populate the local cache so that \\\`get --detailed\\\` can be measured without network access.

## Introduction

Benchmarking startup and cached commands.

## References

[1] A. Lovelace, \\"Notes on Benchmarking,\\" 1833.
`

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const { NodeRuntime, NodeServices } = await import("@effect/platform-node")
  NodeRuntime.runMain(
    runCliPerfBenchmark().pipe(
      Effect.provide(NodeServices.layer)
    ),
    { disableErrorReporting: true }
  )
}
