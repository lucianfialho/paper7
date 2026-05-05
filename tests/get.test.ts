import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Ar5ivClient, Ar5ivDecodeError, type Ar5ivClientShape } from "../src/ar5iv.js"
import { ArxivClient, ArxivDecodeError, makeArxivClient, type ArxivClientShape } from "../src/arxiv.js"
import { rootCommand, VERSION } from "../src/cli.js"
import { CliValidationError } from "../src/cliValidation.js"
import { CrossrefClient, CrossrefDecodeError, type CrossrefClientShape } from "../src/crossref.js"
import { PubmedClient, PubmedDecodeError, type PubmedClientShape } from "../src/pubmed.js"
import { SemanticScholarClient, SemanticScholarDecodeError, type SemanticScholarClientShape } from "../src/semanticScholar.js"
import {
  GetAr5ivError,
  GetArxivError,
  GetCacheReadError,
  GetCacheWriteError,
  GetCrossrefError,
  GetPubmedError,
  GetRangeError,
  getArxivPaper,
  getDoiPaper,
  getPubmedPaper,
} from "../src/get.js"

const deterministicCliOutput = CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))

const arxivMetadata = {
  id: "2401.04088",
  title: "Trust Wrapped Arxiv Paper",
  authors: ["Ada Lovelace", "Grace Hopper"],
  published: "2024-01-08",
  abstract: "An abstract from arXiv."
}

const ar5ivHtml = `<article>
<h2>Introduction</h2>
<p>Line one from ar5iv.</p>
<p>Line two from ar5iv.</p>
<h2>References</h2>
<p>[1] A reference.</p>
</article>`

const pubmedMetadata = {
  id: "pmid:38903003",
  title: "Trust Wrapped PubMed Paper",
  authors: ["Katherine Johnson"],
  published: "2024 Jun 18",
  journal: "Journal of Tests",
  doi: "10.5555/pubmed",
  abstract: "A PubMed abstract."
}

const doiMetadata = {
  id: "doi:10.5555/example.paper",
  title: "Trust Wrapped DOI Paper",
  authors: ["Mary Jackson"],
  source: "Crossref Tests",
  published: "2024",
  doi: "10.5555/example.paper",
  fullTextUrl: "https://doi.org/10.5555/example.paper",
  abstract: "A DOI abstract."
}

const unusedArxiv: ArxivClientShape = {
  search: () => Effect.fail(new ArxivDecodeError({ message: "unexpected search" })),
  get: () => Effect.fail(new ArxivDecodeError({ message: "unexpected arXiv get" }))
}

const unusedAr5iv: Ar5ivClientShape = {
  getHtml: () => Effect.fail(new Ar5ivDecodeError({ message: "unexpected ar5iv get" }))
}

const unusedPubmed: PubmedClientShape = {
  search: () => Effect.fail(new PubmedDecodeError({ message: "unexpected search" })),
  get: () => Effect.fail(new PubmedDecodeError({ message: "unexpected PubMed get" }))
}

const unusedCrossref: CrossrefClientShape = {
  get: () => Effect.fail(new CrossrefDecodeError({ message: "unexpected DOI get" }))
}

const emptySemanticScholar: SemanticScholarClientShape = {
  references: () => Effect.fail(new SemanticScholarDecodeError({ message: "unexpected references" })),
  tldr: () => Effect.succeed(undefined)
}

const fixtureClients = (overrides: {
  readonly arxiv?: ArxivClientShape
  readonly ar5iv?: Ar5ivClientShape
  readonly pubmed?: PubmedClientShape
  readonly crossref?: CrossrefClientShape
  readonly semanticScholar?: SemanticScholarClientShape
}) => ({
  arxiv: overrides.arxiv ?? unusedArxiv,
  ar5iv: overrides.ar5iv ?? unusedAr5iv,
  pubmed: overrides.pubmed ?? unusedPubmed,
  crossref: overrides.crossref ?? unusedCrossref,
  semanticScholar: overrides.semanticScholar ?? emptySemanticScholar
})

const runRootWith = (
  args: ReadonlyArray<string>,
  clients: ReturnType<typeof fixtureClients>
) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const program = Command.runWith(rootCommand, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(ArxivClient, clients.arxiv),
      Effect.provideService(Ar5ivClient, clients.ar5iv),
      Effect.provideService(PubmedClient, clients.pubmed),
      Effect.provideService(CrossrefClient, clients.crossref),
      Effect.provideService(SemanticScholarClient, clients.semanticScholar)
    )
    const exit = yield* Effect.result(program)
    const logs = yield* testConsole.logLines
    const errors = yield* testConsole.errorLines
    return {
      exit,
      stdout: logs.map(String).join("\n"),
      stderr: errors.map(String).join("\n")
    }
  }).pipe(
    Effect.provide(deterministicCliOutput),
    Effect.provide(NodeServices.layer)
  )

const withTempHome = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function*() {
    const previousHome = process.env.HOME
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "paper7-get-")))
    process.env.HOME = home
    return yield* effect.pipe(
      Effect.ensuring(Effect.sync(() => {
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
      }))
    )
  })

const readCache = (home: string, path: ReadonlyArray<string>) =>
  Effect.promise(() => readFile(join(home, ".paper7", "cache", ...path, "paper.md"), { encoding: "utf8" }))

const readMeta = (home: string, path: ReadonlyArray<string>) =>
  Effect.promise(() => readFile(join(home, ".paper7", "cache", ...path, "meta.json"), { encoding: "utf8" }))

const writeCachedPaper = (home: string, path: ReadonlyArray<string>, markdown: string) =>
  Effect.promise(async () => {
    const dir = join(home, ".paper7", "cache", ...path)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "paper.md"), markdown, { encoding: "utf8" })
  })

const longCachedMarkdown = `# Golden Paper

**Authors:** Test Author
**arXiv:** https://arxiv.org/abs/2401.04088
**TLDR:** Cached TLDR.

---

Golden abstract first sentence.

# First Top Section
Content line 1.
Content line 2.
Content line 3.
Content line 4.
Content line 5.
Content line 6.
Content line 7.
Content line 8.
Content line 9.
Content line 10.
Content line 11.
Content line 12.
Content line 13.
Content line 14.
Content line 15.
Content line 16.
Content line 17.
Content line 18.
Content line 19.
Content line 20.

## Subsection A
Sub content.
Sub content 2.
Sub content 3.
Sub content 4.
Sub content 5.
Sub content 6.
Sub content 7.
Sub content 8.
Sub content 9.
Sub content 10.

## References
Reference 1.
Reference 2.
`

describe("get command", () => {
  it.effect("routes arXiv URLs through typed get config, wraps stdout, and caches canonical markdown", () =>
    withTempHome(Effect.gen(function*() {
      const home = process.env.HOME ?? ""
      let requestedId = ""
      const result = yield* runRootWith(["get", "https://arxiv.org/abs/2401.04088v2", "--detailed", "--no-tldr"], fixtureClients({
        arxiv: { search: unusedArxiv.search, get: (id) => Effect.sync(() => { requestedId = id }).pipe(Effect.as(arxivMetadata)) },
        ar5iv: { getHtml: () => Effect.succeed(ar5ivHtml) }
      }))
      const cached = yield* readCache(home, ["2401.04088"])

      expect(result.exit._tag).toBe("Success")
      expect(requestedId).toBe("2401.04088")
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain(`<untrusted-content source="arxiv" id="2401.04088">`)
      expect(result.stdout).toContain("# Trust Wrapped Arxiv Paper")
      expect(result.stdout).toContain("</untrusted-content>")
      expect(cached).toContain("# Trust Wrapped Arxiv Paper")
      expect(cached).not.toContain("<untrusted-content")
    })))

  it.effect("routes PubMed URLs and uses compatible pmid cache keys", () =>
    withTempHome(Effect.gen(function*() {
      const home = process.env.HOME ?? ""
      let requestedId = ""
      const result = yield* runRootWith(["get", "https://pubmed.ncbi.nlm.nih.gov/38903003/", "--detailed", "--no-tldr"], fixtureClients({
        pubmed: { search: unusedPubmed.search, get: (id) => Effect.sync(() => { requestedId = id }).pipe(Effect.as(pubmedMetadata)) }
      }))
      const cached = yield* readCache(home, ["pmid-38903003"])
      const meta = yield* readMeta(home, ["pmid-38903003"])

      expect(result.exit._tag).toBe("Success")
      expect(requestedId).toBe("38903003")
      expect(result.stdout).toContain(`<untrusted-content source="pubmed" id="pmid:38903003">`)
      expect(cached).toContain("**PubMed:** https://pubmed.ncbi.nlm.nih.gov/38903003/")
      expect(cached).not.toContain("<untrusted-content")
      expect(meta).toContain('"id":"pmid:38903003"')
      expect(meta).toContain('"title":"Trust Wrapped PubMed Paper"')
    })))

  it.effect("routes DOI identifiers and uses filesystem-safe DOI cache keys", () =>
    withTempHome(Effect.gen(function*() {
      const home = process.env.HOME ?? ""
      let requestedDoi = ""
      const result = yield* runRootWith(["get", "doi:10.5555/example.paper", "--detailed", "--no-tldr"], fixtureClients({
        crossref: { get: (doi) => Effect.sync(() => { requestedDoi = doi }).pipe(Effect.as(doiMetadata)) }
      }))
      const cached = yield* readCache(home, ["doi-10.5555_example.paper"])
      const meta = yield* readMeta(home, ["doi-10.5555_example.paper"])

      expect(result.exit._tag).toBe("Success")
      expect(requestedDoi).toBe("10.5555/example.paper")
      expect(result.stdout).toContain(`<untrusted-content source="doi" id="doi:10.5555/example.paper">`)
      expect(cached).toContain("**DOI:** 10.5555/example.paper")
      expect(cached).not.toContain("<untrusted-content")
      expect(meta).toContain('"id":"doi:10.5555/example.paper"')
      expect(meta).toContain('"title":"Trust Wrapped DOI Paper"')
    })))

  it.effect("wraps cache hits without mutating canonical cached markdown", () =>
    withTempHome(Effect.gen(function*() {
      const home = process.env.HOME ?? ""
      yield* writeCachedPaper(home, ["2401.04088"], longCachedMarkdown)

      const result = yield* runRootWith(["get", "2401.04088", "--detailed"], fixtureClients({}))
      const cached = yield* readCache(home, ["2401.04088"])

      expect(result.exit._tag).toBe("Success")
      expect(result.stdout).toContain(`<untrusted-content source="arxiv" id="2401.04088">`)
      expect(result.stdout).toContain("# Golden Paper")
      expect(result.stdout).toContain("Cached TLDR.")
      expect(cached).toBe(longCachedMarkdown)
      expect(cached).not.toContain("<untrusted-content")
    })))

  it.effect("compact cache output includes summary, index, range hint, and single-hash sections", () =>
    withTempHome(Effect.gen(function*() {
      const home = process.env.HOME ?? ""
      yield* writeCachedPaper(home, ["2401.04088"], longCachedMarkdown)

      const result = yield* runRootWith(["get", "2401.04088", "--no-tldr"], fixtureClients({}))

      expect(result.exit._tag).toBe("Success")
      expect(result.stdout).toContain("**Summary:** Golden abstract first sentence.")
      expect(result.stdout).toContain("**Index:**")
      expect(result.stdout).toContain("| First Top Section |")
      expect(result.stdout).toContain("| Subsection A |")
      expect(result.stdout).toContain("paper7 get 2401.04088 --detailed --range START:END")
      expect(result.stdout).not.toContain("Cached TLDR.")
    })))

  it.effect("validates get modes at the Effect CLI boundary", () =>
    Effect.gen(function*() {
      const badRange = yield* runRootWith(["get", "2401.04088", "--range", "10:2", "--detailed"], fixtureClients({}))
      const rangeWithoutDetailed = yield* runRootWith(["get", "2401.04088", "--range", "1:2"], fixtureClients({}))
      const jsonFlag = yield* runRootWith(["get", "2401.04088", "--json"], fixtureClients({}))
      const badId = yield* runRootWith(["get", "pmid:not-a-number"], fixtureClients({}))

      expect(badRange.exit._tag).toBe("Failure")
      expect(rangeWithoutDetailed.exit._tag).toBe("Failure")
      expect(jsonFlag.exit._tag).toBe("Failure")
      expect(jsonFlag.stderr).toContain("json")
      expect(badId.exit._tag).toBe("Failure")
    }))

  it.effect("surfaces typed CliValidationError for invalid identifiers and ranges", () =>
    Effect.gen(function*() {
      const recoveredPubmed = yield* Command.runWith(rootCommand, { version: VERSION })(["get", "pmid:not-a-number"]).pipe(
        Effect.catchTag("CliValidationError", (error) => Effect.succeed(error.message))
      )
      const recoveredDoi = yield* Command.runWith(rootCommand, { version: VERSION })(["get", "doi:bad"]).pipe(
        Effect.catchTag("CliValidationError", (error) => Effect.succeed(error.message))
      )
      const recoveredRange = yield* Command.runWith(rootCommand, { version: VERSION })(["get", "2401.04088", "--range", "1:2"]).pipe(
        Effect.catchTag("CliValidationError", (error) => Effect.succeed(error.message))
      )

      expect(recoveredPubmed).toBe("invalid PubMed ID: pmid:not-a-number")
      expect(recoveredDoi).toBe("invalid DOI: doi:bad")
      expect(recoveredRange).toBe("--range requires --detailed")
    }).pipe(
      Effect.provide(deterministicCliOutput),
      Effect.provide(NodeServices.layer)
    ))

  it.effect("applies detailed range, no-refs, no-cache, and no-tldr modes", () =>
    withTempHome(Effect.gen(function*() {
      const home = process.env.HOME ?? ""
      let arxivCalls = 0
      yield* writeCachedPaper(home, ["2401.04088"], "# Stale\n\nstale-cache\n")
      const result = yield* runRootWith(["get", "2401.04088", "--detailed", "--range", "1:12", "--no-refs", "--no-cache", "--no-tldr"], fixtureClients({
        arxiv: { search: unusedArxiv.search, get: () => Effect.sync(() => { arxivCalls += 1 }).pipe(Effect.as(arxivMetadata)) },
        ar5iv: { getHtml: () => Effect.succeed(ar5ivHtml) }
      }))
      const cached = yield* readCache(home, ["2401.04088"])

      expect(result.exit._tag).toBe("Success")
      expect(arxivCalls).toBe(1)
      expect(result.stdout).toContain("**Range:** 1-12 of")
      expect(result.stdout).not.toContain("## References")
      expect(result.stdout).not.toContain("**TLDR:**")
      expect(result.stdout).not.toContain("stale-cache")
      expect(cached).toContain("# Trust Wrapped Arxiv Paper")
      expect(cached).not.toContain("stale-cache")
    })))

  it.effect("includes TLDR output through the Semantic Scholar service seam", () =>
    withTempHome(Effect.gen(function*() {
      const home = process.env.HOME ?? ""
      const result = yield* runRootWith(["get", "2401.04088", "--detailed", "--no-cache"], fixtureClients({
        arxiv: { search: unusedArxiv.search, get: () => Effect.succeed(arxivMetadata) },
        ar5iv: { getHtml: () => Effect.succeed(ar5ivHtml) },
        semanticScholar: {
          references: emptySemanticScholar.references,
          tldr: (id) => id.tag === "arxiv" && id.id === "2401.04088"
            ? Effect.succeed("Fixture TLDR from Semantic Scholar.")
            : Effect.fail(new SemanticScholarDecodeError({ message: "unexpected TLDR id" }))
        }
      }))
      const cached = yield* readCache(home, ["2401.04088"])

      expect(result.exit._tag).toBe("Success")
      expect(result.stdout).toContain("**TLDR:** Fixture TLDR from Semantic Scholar.")
      expect(cached).toContain("**TLDR:** Fixture TLDR from Semantic Scholar.")
      expect(cached).not.toContain("<untrusted-content")
    })))

  it.effect("surfaces typed upstream failures", () =>
    withTempHome(Effect.gen(function*() {
      const result = yield* runRootWith(["get", "doi:10.5555/example.paper", "--no-tldr"], fixtureClients({
        crossref: { get: () => Effect.fail(new CrossrefDecodeError({ message: "Crossref bad shape" })) }
      }))
      const ar5ivResult = yield* runRootWith(["get", "2401.04088", "--no-tldr"], fixtureClients({
        arxiv: { search: unusedArxiv.search, get: () => Effect.succeed(arxivMetadata) },
        ar5iv: { getHtml: () => Effect.fail(new Ar5ivDecodeError({ message: "ar5iv response missing article" })) }
      }))

      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toBe("error: Crossref decode failure: Crossref bad shape")
      expect(ar5ivResult.exit._tag).toBe("Failure")
      expect(ar5ivResult.stderr).toBe("error: ar5iv decode failure: ar5iv response missing article")
    })))

  it.effect("abstract-only fetches metadata without full-text client", () =>
    withTempHome(Effect.gen(function*() {
      const arxivResult = yield* runRootWith(["get", "2401.04088", "--abstract-only", "--no-tldr"], fixtureClients({
        arxiv: { search: unusedArxiv.search, get: () => Effect.succeed(arxivMetadata) },
        ar5iv: unusedAr5iv
      }))
      const pubmedResult = yield* runRootWith(["get", "pmid:38903003", "--abstract-only", "--no-tldr"], fixtureClients({
        pubmed: { search: unusedPubmed.search, get: () => Effect.succeed(pubmedMetadata) }
      }))
      const doiResult = yield* runRootWith(["get", "doi:10.5555/example.paper", "--abstract-only", "--no-tldr"], fixtureClients({
        crossref: { get: () => Effect.succeed(doiMetadata) }
      }))

      expect(arxivResult.exit._tag).toBe("Success")
      expect(arxivResult.stdout).toContain("## Abstract")
      expect(arxivResult.stdout).toContain("An abstract from arXiv.")
      expect(arxivResult.stdout).not.toContain("Introduction")
      expect(pubmedResult.stdout).toContain("A PubMed abstract.")
      expect(doiResult.stdout).toContain("**DOI:** 10.5555/example.paper")
    })))
})

describe("get yieldable failures", () => {
  it.effect("getArxivPaper yields GetArxivError with nested ArxivDecodeError", () =>
    Effect.gen(function*() {
      const arxivClient: ArxivClientShape = {
        search: () => Effect.fail(new ArxivDecodeError({ message: "unexpected search" })),
        get: () => Effect.fail(new ArxivDecodeError({ message: "arXiv decode failure" })),
      }
      const ar5ivClient: Ar5ivClientShape = {
        getHtml: () => Effect.succeed(ar5ivHtml),
      }
      const semanticScholar: SemanticScholarClientShape = {
        references: () => Effect.fail(new SemanticScholarDecodeError({ message: "unexpected references" })),
        tldr: () => Effect.succeed(undefined),
      }

      const result = yield* getArxivPaper({ id: "2401.04088", cache: false, refs: true, tldr: false, detailed: true, abstractOnly: false }).pipe(
        Effect.provideService(ArxivClient, arxivClient),
        Effect.provideService(Ar5ivClient, ar5ivClient),
        Effect.provideService(SemanticScholarClient, semanticScholar),
        Effect.catchTag("GetArxivError", (error) => Effect.succeed(error))
      )

      expect(result).toBeInstanceOf(GetArxivError)
      expect(result.error).toBeInstanceOf(ArxivDecodeError)
      expect(result.error.message).toBe("arXiv decode failure")
    }))

  it.effect("getArxivPaper yields GetAr5ivError with nested Ar5ivDecodeError", () =>
    Effect.gen(function*() {
      const arxivClient: ArxivClientShape = {
        search: () => Effect.fail(new ArxivDecodeError({ message: "unexpected search" })),
        get: () => Effect.succeed(arxivMetadata),
      }
      const ar5ivClient: Ar5ivClientShape = {
        getHtml: () => Effect.fail(new Ar5ivDecodeError({ message: "ar5iv decode failure" })),
      }
      const semanticScholar: SemanticScholarClientShape = {
        references: () => Effect.fail(new SemanticScholarDecodeError({ message: "unexpected references" })),
        tldr: () => Effect.succeed(undefined),
      }

      const result = yield* getArxivPaper({ id: "2401.04088", cache: false, refs: true, tldr: false, detailed: true, abstractOnly: false }).pipe(
        Effect.provideService(ArxivClient, arxivClient),
        Effect.provideService(Ar5ivClient, ar5ivClient),
        Effect.provideService(SemanticScholarClient, semanticScholar),
        Effect.catchTag("GetAr5ivError", (error) => Effect.succeed(error))
      )

      expect(result).toBeInstanceOf(GetAr5ivError)
      expect(result.error).toBeInstanceOf(Ar5ivDecodeError)
      expect(result.error.message).toBe("ar5iv decode failure")
    }))

  it.effect("getPubmedPaper yields GetPubmedError with nested PubmedDecodeError", () =>
    Effect.gen(function*() {
      const pubmedClient: PubmedClientShape = {
        search: () => Effect.fail(new PubmedDecodeError({ message: "unexpected search" })),
        get: () => Effect.fail(new PubmedDecodeError({ message: "PubMed decode failure" })),
      }
      const semanticScholar: SemanticScholarClientShape = {
        references: () => Effect.fail(new SemanticScholarDecodeError({ message: "unexpected references" })),
        tldr: () => Effect.succeed(undefined),
      }

      const result = yield* getPubmedPaper({ id: "38903003", cache: false, refs: true, tldr: false, detailed: true, abstractOnly: false }).pipe(
        Effect.provideService(PubmedClient, pubmedClient),
        Effect.provideService(SemanticScholarClient, semanticScholar),
        Effect.catchTag("GetPubmedError", (error) => Effect.succeed(error))
      )

      expect(result).toBeInstanceOf(GetPubmedError)
      expect(result.error).toBeInstanceOf(PubmedDecodeError)
      expect(result.error.message).toBe("PubMed decode failure")
    }))

  it.effect("getDoiPaper yields GetCrossrefError with nested CrossrefDecodeError", () =>
    Effect.gen(function*() {
      const crossrefClient: CrossrefClientShape = {
        get: () => Effect.fail(new CrossrefDecodeError({ message: "Crossref decode failure" })),
      }
      const arxivClient: ArxivClientShape = {
        search: () => Effect.fail(new ArxivDecodeError({ message: "unexpected search" })),
        get: () => Effect.fail(new ArxivDecodeError({ message: "unexpected arXiv get" })),
      }
      const ar5ivClient: Ar5ivClientShape = {
        getHtml: () => Effect.fail(new Ar5ivDecodeError({ message: "unexpected ar5iv get" })),
      }
      const semanticScholar: SemanticScholarClientShape = {
        references: () => Effect.fail(new SemanticScholarDecodeError({ message: "unexpected references" })),
        tldr: () => Effect.succeed(undefined),
      }

      const result = yield* getDoiPaper({ id: "10.5555/example.paper", cache: false, refs: true, tldr: false, detailed: true, abstractOnly: false }).pipe(
        Effect.provideService(CrossrefClient, crossrefClient),
        Effect.provideService(ArxivClient, arxivClient),
        Effect.provideService(Ar5ivClient, ar5ivClient),
        Effect.provideService(SemanticScholarClient, semanticScholar),
        Effect.catchTag("GetCrossrefError", (error) => Effect.succeed(error))
      )

      expect(result).toBeInstanceOf(GetCrossrefError)
      expect(result.error).toBeInstanceOf(CrossrefDecodeError)
      expect(result.error.message).toBe("Crossref decode failure")
    }))

  it.effect("GetRangeError is yieldable and recoverable", () =>
    Effect.gen(function*() {
      const arxivClient: ArxivClientShape = {
        search: () => Effect.fail(new ArxivDecodeError({ message: "unexpected search" })),
        get: () => Effect.succeed(arxivMetadata),
      }
      const ar5ivClient: Ar5ivClientShape = {
        getHtml: () => Effect.succeed(ar5ivHtml),
      }

      const result = yield* getArxivPaper({ id: "2401.04088", cache: false, refs: true, tldr: false, detailed: true, abstractOnly: false, range: { start: 1000, end: 2000 } }).pipe(
        Effect.provideService(ArxivClient, arxivClient),
        Effect.provideService(Ar5ivClient, ar5ivClient),
        Effect.catchTag("GetRangeError", (error) => Effect.succeed(error))
      )

      expect(result).toBeInstanceOf(GetRangeError)
      expect(result.message).toContain("range start 1000 exceeds total lines")
    }))

  it.effect("TLDR enrichment failure remains non-fatal and omits TLDR", () =>
    Effect.gen(function*() {
      const arxivClient: ArxivClientShape = {
        search: () => Effect.fail(new ArxivDecodeError({ message: "unexpected search" })),
        get: () => Effect.succeed(arxivMetadata),
      }
      const ar5ivClient: Ar5ivClientShape = {
        getHtml: () => Effect.succeed(ar5ivHtml),
      }
      const semanticScholar: SemanticScholarClientShape = {
        references: () => Effect.fail(new SemanticScholarDecodeError({ message: "unexpected references" })),
        tldr: () => Effect.fail(new SemanticScholarDecodeError({ message: "TLDR failure" })),
      }

      const result = yield* getArxivPaper({ id: "2401.04088", cache: false, refs: true, tldr: true, detailed: true, abstractOnly: false }).pipe(
        Effect.provideService(ArxivClient, arxivClient),
        Effect.provideService(Ar5ivClient, ar5ivClient),
        Effect.provideService(SemanticScholarClient, semanticScholar)
      )

      expect(result).not.toContain("**TLDR:**")
    }))
})

describe("get source clients", () => {
  it.effect("retries transient arXiv get failures with TestClock", () =>
    Effect.gen(function*() {
      let calls = 0
      const client = makeArxivClient({
        fetchImpl: async () => {
          calls += 1
          if (calls === 1) return new Response("retry", { status: 500 })
          return new Response(`<?xml version="1.0"?>
            <feed><entry>
              <id>http://arxiv.org/abs/2401.04088v1</id>
              <published>2024-01-08T18:59:59Z</published>
              <title>Retried Paper</title>
              <author><name>Ada Lovelace</name></author>
              <summary>Retried abstract.</summary>
            </entry></feed>`, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 1,
        retryDelay: "1 second"
      })

      const fiber = yield* client.get("2401.04088").pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      const paper = yield* Fiber.join(fiber)

      expect(calls).toBe(2)
      expect(paper.title).toBe("Retried Paper")
    }))
})
