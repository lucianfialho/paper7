import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ar5ivClient, type Ar5ivClientShape } from "../src/ar5iv.js"
import { ArxivClient, ArxivDecodeError, type ArxivClientShape } from "../src/arxiv.js"
import { rootCommand, VERSION } from "../src/cli.js"
import { CrossrefClient, CrossrefDecodeError, type CrossrefClientShape } from "../src/crossref.js"
import { PubmedClient, PubmedDecodeError, type PubmedClientShape } from "../src/pubmed.js"
import { SemanticScholarClient, SemanticScholarDecodeError, type SemanticScholarClientShape } from "../src/semanticScholar.js"

const deterministicCliOutput = CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))

const clients = {
  arxiv: {
    search: () => Effect.fail(new ArxivDecodeError({ message: "unexpected search" })),
    get: () => Effect.succeed({
      id: "1706.03762",
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani"],
      published: "2017-06-12",
      abstract: "Transformer abstract.",
    }),
  } satisfies ArxivClientShape,
  ar5iv: {
    getHtml: () => Effect.succeed("<article><h2>Introduction</h2><p>Transformer body.</p></article>"),
  } satisfies Ar5ivClientShape,
  crossref: {
    get: () => Effect.fail(new CrossrefDecodeError({ message: "unexpected DOI get" })),
  } satisfies CrossrefClientShape,
  pubmed: {
    search: () => Effect.fail(new PubmedDecodeError({ message: "unexpected search" })),
    get: () => Effect.fail(new PubmedDecodeError({ message: "unexpected PubMed get" })),
  } satisfies PubmedClientShape,
  semanticScholar: {
    references: () => Effect.fail(new SemanticScholarDecodeError({ message: "unexpected references" })),
    tldr: () => Effect.succeed(undefined),
  } satisfies SemanticScholarClientShape,
}

const withTempHome = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function*() {
    const previousHome = process.env.HOME
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "paper7-kb-")))
    process.env.HOME = home
    return yield* effect.pipe(
      Effect.ensuring(Effect.sync(() => {
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
      }))
    )
  })

const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const exit = yield* Command.runWith(rootCommand, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(ArxivClient, clients.arxiv),
      Effect.provideService(Ar5ivClient, clients.ar5iv),
      Effect.provideService(CrossrefClient, clients.crossref),
      Effect.provideService(PubmedClient, clients.pubmed),
      Effect.provideService(SemanticScholarClient, clients.semanticScholar),
      Effect.result
    )
    const logs = yield* testConsole.logLines
    const errors = yield* testConsole.errorLines
    return { exit, stdout: logs.map(String).join("\n"), stderr: errors.map(String).join("\n") }
  }).pipe(
    Effect.provide(deterministicCliOutput),
    Effect.provide(NodeServices.layer)
  )

describe("kb command", () => {
  it.effect("manages local wiki pages and ingests sources", () =>
    withTempHome(Effect.gen(function*() {
      const home = process.env.HOME ?? ""
      const pages = join(home, ".paper7", "wiki", "pages")
      yield* Effect.promise(() => mkdir(pages, { recursive: true }))
      yield* Effect.promise(() => writeFile(join(pages, "attention.md"), "# Attention\n\nTransformer note.\n", { encoding: "utf8" }))

      const read = yield* run(["kb", "read", "attention"])
      const search = yield* run(["kb", "search", "Transformer"])
      const list = yield* run(["kb", "list"])
      const status = yield* run(["kb", "status"])
      const ingest = yield* run(["kb", "ingest", "1706.03762"])

      expect(read.exit._tag).toBe("Success")
      expect(read.stdout).toContain("Transformer note")
      expect(search.stdout).toContain("attention.md")
      expect(list.stdout).toContain("attention")
      expect(status.stdout).toContain("Pages: 1")
      expect(ingest.stdout).toContain("Attention Is All You Need")
    })))
})
