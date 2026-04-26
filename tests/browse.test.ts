import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect, Ref, Sink, Stdio, Stream } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ar5ivClient, type Ar5ivClientShape } from "../src/ar5iv.js"
import { ArxivClient, type ArxivClientShape } from "../src/arxiv.js"
import { CachePaths } from "../src/cache.js"
import { rootCommand, VERSION } from "../src/cli.js"
import { CrossrefClient, type CrossrefClientShape } from "../src/crossref.js"
import { PubmedClient, type PubmedClientShape } from "../src/pubmed.js"
import { RepositoryDiscoveryClient, type RepositoryDiscoveryClientShape } from "../src/repo.js"
import { SemanticScholarClient, type SemanticScholarClientShape } from "../src/semanticScholar.js"

const deterministicCliOutput = CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))

const unusedArxiv: ArxivClientShape = {
  search: () => Effect.fail({ _tag: "ArxivDecodeError", message: "unexpected search" }),
  get: () => Effect.fail({ _tag: "ArxivDecodeError", message: "unexpected get" })
}

const unusedAr5iv: Ar5ivClientShape = {
  getHtml: () => Effect.fail({ _tag: "Ar5ivDecodeError", message: "unexpected get" })
}

const unusedPubmed: PubmedClientShape = {
  search: () => Effect.fail({ _tag: "PubmedDecodeError", message: "unexpected search" }),
  get: () => Effect.fail({ _tag: "PubmedDecodeError", message: "unexpected get" })
}

const unusedCrossref: CrossrefClientShape = {
  get: () => Effect.fail({ _tag: "CrossrefDecodeError", message: "unexpected get" })
}

const unusedSemanticScholar: SemanticScholarClientShape = {
  references: () => Effect.fail({ _tag: "SemanticScholarDecodeError", message: "unexpected references" }),
  tldr: () => Effect.fail({ _tag: "SemanticScholarDecodeError", message: "unexpected tldr" })
}

const unusedRepositoryDiscovery: RepositoryDiscoveryClientShape = {
  discover: () => Effect.fail({ _tag: "PapersWithCodeDecodeError", message: "unexpected discover" })
}

const makeStdioLayer = (input: string) =>
  Effect.gen(function*() {
    const stdout = yield* Ref.make("")
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const layer = Stdio.layerTest({
      args: Effect.succeed([]),
      stdin: input === "" ? Stream.empty : Stream.make(encoder.encode(input)),
      stdout: () => Sink.forEach((chunk: string | Uint8Array) =>
        Ref.update(stdout, (current) => current + (typeof chunk === "string" ? chunk : decoder.decode(chunk)))
      )
    })
    return { layer, stdout }
  })

const runRootWith = (cacheRoot: string, input: string) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const stdio = yield* makeStdioLayer(input)
    const program = Command.runWith(rootCommand, { version: VERSION })(["browse"]).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(CachePaths, { cacheRoot }),
      Effect.provideService(ArxivClient, unusedArxiv),
      Effect.provideService(Ar5ivClient, unusedAr5iv),
      Effect.provideService(PubmedClient, unusedPubmed),
      Effect.provideService(CrossrefClient, unusedCrossref),
      Effect.provideService(SemanticScholarClient, unusedSemanticScholar),
      Effect.provideService(RepositoryDiscoveryClient, unusedRepositoryDiscovery),
      Effect.provide(stdio.layer)
    )
    const exit = yield* Effect.result(program)
    const prompt = yield* Ref.get(stdio.stdout)
    const logs = yield* testConsole.logLines
    const errors = yield* testConsole.errorLines
    return {
      exit,
      prompt,
      stdout: logs.map(String).join("\n"),
      stderr: errors.map(String).join("\n")
    }
  }).pipe(
    Effect.provide(deterministicCliOutput),
    Effect.provide(NodeServices.layer)
  )

const withTempCache = <A, E, R>(effect: (cacheRoot: string) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "paper7-browse-"))),
    (root) => effect(join(root, "cache")),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
  )

const writeEntry = (
  cacheRoot: string,
  dirname: string,
  meta: { readonly id: string; readonly title: string; readonly authors?: string; readonly url?: string },
  markdown: string | undefined
) =>
  Effect.promise(async () => {
    const dir = join(cacheRoot, dirname)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta), { encoding: "utf8" })
    if (markdown !== undefined) await writeFile(join(dir, "paper.md"), markdown, { encoding: "utf8" })
  })

describe("browse command", () => {
  it.effect("routes browse through Effect CLI and handles empty cache", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      const result = yield* runRootWith(cacheRoot, "")

      expect(result.exit._tag).toBe("Success")
      expect(result.prompt).toBe("")
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe("No papers cached")
    })))

  it.effect("handles canceled input", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "1706.03762", { id: "1706.03762", title: "Attention Is All You Need" }, "# Attention\n")

      const result = yield* runRootWith(cacheRoot, "q\n")

      expect(result.exit._tag).toBe("Success")
      expect(result.prompt).toContain("1. [1706.03762] Attention Is All You Need")
      expect(result.stdout).toBe("Browse cancelled")
    })))

  it.effect("handles EOF input as cancellation", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "1706.03762", { id: "1706.03762", title: "Attention Is All You Need" }, "# Attention\n")

      const result = yield* runRootWith(cacheRoot, "")

      expect(result.exit._tag).toBe("Success")
      expect(result.prompt).toContain("> ")
      expect(result.stdout).toBe("Browse cancelled")
    })))

  it.effect("rejects invalid selection clearly", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "1706.03762", { id: "1706.03762", title: "Attention Is All You Need" }, "# Attention\n")

      const result = yield* runRootWith(cacheRoot, "9\n")

      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toBe("error: invalid selection")
    })))

  it.effect("reports missing selected markdown", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "2401.04088", { id: "2401.04088", title: "Missing Markdown" }, undefined)

      const result = yield* runRootWith(cacheRoot, "1\n")

      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toBe("error: no cached paper for 2401.04088")
    })))

  it.effect("selects a single cached entry and prints canonical markdown", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "1706.03762", { id: "1706.03762", title: "Attention Is All You Need" }, "# Attention Is All You Need\n\nBody...\n")

      const result = yield* runRootWith(cacheRoot, "1\n")

      expect(result.exit._tag).toBe("Success")
      expect(result.prompt).toContain("1. [1706.03762] Attention Is All You Need")
      expect(result.stdout).toBe("# Attention Is All You Need\n\nBody...\n")
      expect(result.stdout).not.toContain("DO-NOT-INVOKE")
    })))

  it.effect("uses the first input line as the selection", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "1706.03762", { id: "1706.03762", title: "Attention Is All You Need" }, "# Attention\n")

      const result = yield* runRootWith(cacheRoot, "1\n9\n")

      expect(result.exit._tag).toBe("Success")
      expect(result.stdout).toBe("# Attention\n")
    })))

  it.effect("selects among multiple entries without fzf glow jq or shell execution", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      const previousPath = process.env.PATH
      process.env.PATH = "/does/not/exist"
      yield* writeEntry(cacheRoot, "1706.03762", { id: "1706.03762", title: "Attention Is All You Need" }, "# Attention\n")
      yield* writeEntry(cacheRoot, "pmid-38903003", { id: "pmid:38903003", title: "Hypertensive Emergency" }, "# Hypertensive Emergency\n\nClinical body...\n")

      const result = yield* runRootWith(cacheRoot, "2\n").pipe(
        Effect.ensuring(Effect.sync(() => {
          if (previousPath === undefined) delete process.env.PATH
          else process.env.PATH = previousPath
        }))
      )

      expect(result.exit._tag).toBe("Success")
      expect(result.prompt).toContain("1. [1706.03762] Attention Is All You Need")
      expect(result.prompt).toContain("2. [pmid:38903003] Hypertensive Emergency")
      expect(result.stdout).toContain("# Hypertensive Emergency")
      expect(result.stdout).toContain("Clinical body")
      expect(result.stdout).not.toContain("DO-NOT-INVOKE")
    })))
})
