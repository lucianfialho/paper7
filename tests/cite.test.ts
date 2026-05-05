import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { ArxivClient, ArxivDecodeError, type ArxivClientShape } from "../src/arxiv.js"
import { rootCommand, VERSION } from "../src/cli.js"
import { CrossrefClient, CrossrefDecodeError, type CrossrefClientShape } from "../src/crossref.js"
import { PubmedClient, PubmedDecodeError, type PubmedClientShape } from "../src/pubmed.js"

const deterministicCliOutput = CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))

const arxiv: ArxivClientShape = {
  search: () => Effect.fail(new ArxivDecodeError({ message: "unexpected search" })),
  get: () => Effect.succeed({
    id: "1706.03762",
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani", "Noam Shazeer"],
    published: "2017-06-12",
    abstract: "Transformer paper.",
  }),
}

const crossref: CrossrefClientShape = {
  get: () => Effect.succeed({
    id: "doi:10.1126/science.1439786",
    title: "Homobatrachotoxin in the genus Pitohui",
    authors: ["John P. Dumbacher", "Avit Wako"],
    source: "Science",
    published: "1992",
    doi: "10.1126/science.1439786",
    fullTextUrl: "https://doi.org/10.1126/science.1439786",
    abstract: "Toxic bird paper.",
  }),
}

const pubmed: PubmedClientShape = {
  search: () => Effect.fail(new PubmedDecodeError({ message: "unexpected search" })),
  get: () => Effect.succeed({
    id: "pmid:38903003",
    title: "Clinical Case",
    authors: ["Katherine Johnson", "Mary Jackson", "Dorothy Vaughan", "Christine Darden"],
    published: "2024 Jun 18",
    journal: "Journal of Tests",
    doi: "10.5555/pubmed",
    abstract: "A PubMed abstract.",
  }),
}

const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const exit = yield* Command.runWith(rootCommand, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(ArxivClient, arxiv),
      Effect.provideService(CrossrefClient, crossref),
      Effect.provideService(PubmedClient, pubmed),
      Effect.result
    )
    const logs = yield* testConsole.logLines
    const errors = yield* testConsole.errorLines
    return { exit, stdout: logs.map(String).join("\n"), stderr: errors.map(String).join("\n") }
  }).pipe(
    Effect.provide(deterministicCliOutput),
    Effect.provide(NodeServices.layer)
  )

describe("cite command", () => {
  it.effect("formats BibTeX, APA, and ABNT citations from typed clients", () =>
    Effect.gen(function*() {
      const bibtex = yield* run(["cite", "1706.03762", "--format", "bibtex"])
      const apa = yield* run(["cite", "doi:10.1126/science.1439786", "--format", "apa"])
      const abnt = yield* run(["cite", "pmid:38903003", "--format", "abnt"])

      expect(bibtex.exit._tag).toBe("Success")
      expect(bibtex.stdout).toContain("@article{vaswani2017attention")
      expect(bibtex.stdout).toContain("Attention Is All You Need")
      expect(apa.stdout).toContain("Dumbacher")
      expect(apa.stdout).toContain("(1992)")
      expect(apa.stdout).toContain("https://doi.org/10.1126/science.1439786")
      expect(abnt.stdout).toContain("JOHNSON, K. et al")
      expect(abnt.stdout).toContain("2024")
      expect(abnt.stdout).toContain("Disponível em:")
    }))

  it.effect("rejects unknown citation formats at the CLI boundary", () =>
    Effect.gen(function*() {
      const result = yield* run(["cite", "1706.03762", "--format", "yaml"])

      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toContain("yaml")
    }))
})
