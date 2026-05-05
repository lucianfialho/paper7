import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ar5ivClient, Ar5ivDecodeError, type Ar5ivClientShape } from "../src/ar5iv.js"
import { ArxivClient, ArxivDecodeError, type ArxivClientShape } from "../src/arxiv.js"
import { CachePaths } from "../src/cache.js"
import { rootCommand, VERSION } from "../src/cli.js"
import { CrossrefClient, CrossrefDecodeError, type CrossrefClientShape } from "../src/crossref.js"
import { PubmedClient, PubmedDecodeError, type PubmedClientShape } from "../src/pubmed.js"
import { PapersWithCodeDecodeError, RepositoryDiscoveryClient, type RepositoryDiscoveryClientShape } from "../src/repo.js"
import { SemanticScholarClient, SemanticScholarDecodeError, type SemanticScholarClientShape } from "../src/semanticScholar.js"

const deterministicCliOutput = CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))

const unusedArxiv: ArxivClientShape = {
  search: () => Effect.fail(new ArxivDecodeError({ message: "unexpected search" })),
  get: () => Effect.fail(new ArxivDecodeError({ message: "unexpected get" }))
}

const unusedAr5iv: Ar5ivClientShape = {
  getHtml: () => Effect.fail(new Ar5ivDecodeError({ message: "unexpected get" }))
}

const unusedPubmed: PubmedClientShape = {
  search: () => Effect.fail(new PubmedDecodeError({ message: "unexpected search" })),
  get: () => Effect.fail(new PubmedDecodeError({ message: "unexpected get" }))
}

const unusedCrossref: CrossrefClientShape = {
  get: () => Effect.fail(new CrossrefDecodeError({ message: "unexpected get" }))
}

const unusedSemanticScholar: SemanticScholarClientShape = {
  references: () => Effect.fail(new SemanticScholarDecodeError({ message: "unexpected references" })),
  tldr: () => Effect.fail(new SemanticScholarDecodeError({ message: "unexpected tldr" }))
}

const unusedRepositoryDiscovery: RepositoryDiscoveryClientShape = {
  discover: () => Effect.fail(new PapersWithCodeDecodeError({ message: "unexpected discover" }))
}

const runRootWith = (cacheRoot: string, args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const program = Command.runWith(rootCommand, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(CachePaths, { cacheRoot }),
      Effect.provideService(ArxivClient, unusedArxiv),
      Effect.provideService(Ar5ivClient, unusedAr5iv),
      Effect.provideService(PubmedClient, unusedPubmed),
      Effect.provideService(CrossrefClient, unusedCrossref),
      Effect.provideService(SemanticScholarClient, unusedSemanticScholar),
      Effect.provideService(RepositoryDiscoveryClient, unusedRepositoryDiscovery)
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

const withTempCache = <A, E, R>(effect: (cacheRoot: string) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "paper7-cache-"))),
    (root) => effect(join(root, "cache")),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
  )

const writeEntry = (
  cacheRoot: string,
  dirname: string,
  meta: { readonly id: string; readonly title: string; readonly authors: string; readonly url: string },
  markdown: string
) =>
  Effect.promise(async () => {
    const dir = join(cacheRoot, dirname)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta), { encoding: "utf8" })
    await writeFile(join(dir, "paper.md"), markdown, { encoding: "utf8" })
  })

const writeMalformedEntry = (cacheRoot: string, dirname: string, markdown: string) =>
  Effect.promise(async () => {
    const dir = join(cacheRoot, dirname)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "meta.json"), "{bad json", { encoding: "utf8" })
    await writeFile(join(dir, "paper.md"), markdown, { encoding: "utf8" })
  })

const writeEntryNoMeta = (cacheRoot: string, dirname: string, markdown: string) =>
  Effect.promise(async () => {
    const dir = join(cacheRoot, dirname)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "paper.md"), markdown, { encoding: "utf8" })
  })

const writeEntryWithUnreadablePaper = (
  cacheRoot: string,
  dirname: string,
  meta: { readonly id: string; readonly title: string; readonly authors: string; readonly url: string }
) =>
  Effect.promise(async () => {
    const dir = join(cacheRoot, dirname)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta), { encoding: "utf8" })
    await mkdir(join(dir, "paper.md"), { recursive: true })
  })

const writeSearchCacheEntry = (cacheRoot: string, source: "arxiv" | "pubmed") =>
  Effect.promise(async () => {
    const dir = join(cacheRoot, "search", source)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "test-envelope.json"), JSON.stringify({ test: true }), { encoding: "utf8" })
  })

const searchCacheExists = (cacheRoot: string, source: "arxiv" | "pubmed") =>
  Effect.promise(() => readFile(join(cacheRoot, "search", source, "test-envelope.json")).then(
    () => true,
    () => false
  ))

const pathExists = (path: string) =>
  Effect.promise(() => readFile(path).then(
    () => true,
    () => false
  ))

describe("cache commands", () => {
  it.effect("lists an empty cache through Effect CLI without shell helpers", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      const result = yield* runRootWith(cacheRoot, ["list"])

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe("No cached papers")
    })))

  it.effect("lists arXiv, PubMed, and DOI compatibility cache entries", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "2401.04088", {
        id: "2401.04088",
        title: "Fixture Get Paper",
        authors: "Ada Lovelace",
        url: "https://arxiv.org/abs/2401.04088"
      }, "# Fixture Get Paper\n")
      yield* writeEntry(cacheRoot, "pmid-38903003", {
        id: "pmid:38903003",
        title: "Fixture PubMed Paper",
        authors: "Grace Hopper",
        url: "https://pubmed.ncbi.nlm.nih.gov/38903003/"
      }, "# Fixture PubMed Paper\n")
      yield* writeEntry(cacheRoot, "doi-10.1101_2023.12.15.571821", {
        id: "doi:10.1101/2023.12.15.571821",
        title: "Fixture DOI Paper",
        authors: "Katherine Johnson",
        url: "https://doi.org/10.1101/2023.12.15.571821"
      }, "# Fixture DOI Paper\n")

      const result = yield* runRootWith(cacheRoot, ["list"])

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Cached papers (3):")
      expect(result.stdout).toContain("[2401.04088] Fixture Get Paper")
      expect(result.stdout).toContain("[pmid:38903003] Fixture PubMed Paper")
      expect(result.stdout).toContain("[doi:10.1101/2023.12.15.571821] Fixture DOI Paper")
    })))

  it.effect("warns on malformed metadata and skips unreadable DOI entries", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeMalformedEntry(cacheRoot, "2401.04088", "# Fallback Arxiv\n\n**Authors:** Fallback Author\n")
      yield* writeMalformedEntry(cacheRoot, "doi-bad", "# Bad DOI\n")

      const result = yield* runRootWith(cacheRoot, ["list"])

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("warning: skipping malformed metadata in 2401.04088")
      expect(result.stdout).toContain("warning: skipping malformed metadata in doi-bad")
      expect(result.stdout).toContain("warning: skipping DOI cache without readable metadata in doi-bad")
      expect(result.stdout).toContain("Cached papers (1):")
      expect(result.stdout).toContain("[2401.04088] Fallback Arxiv")
      expect(result.stdout).not.toContain("[doi:")
    })))

  it.effect("uses metadata fast path and does not read paper.md when meta.json is valid", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntryWithUnreadablePaper(cacheRoot, "2401.04088", {
        id: "2401.04088",
        title: "Fast Path Paper",
        authors: "Ada Lovelace",
        url: "https://arxiv.org/abs/2401.04088"
      })

      const result = yield* runRootWith(cacheRoot, ["list"])

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Cached papers (1):")
      expect(result.stdout).toContain("[2401.04088] Fast Path Paper")
    })))

  it.effect("falls back to markdown parsing when meta.json is missing", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntryNoMeta(cacheRoot, "2401.04088", "# Fallback Title\n\n**Authors:** Fallback Author\n**arXiv:** https://arxiv.org/abs/2401.04088\n")

      const result = yield* runRootWith(cacheRoot, ["list"])

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Cached papers (1):")
      expect(result.stdout).toContain("[2401.04088] Fallback Title")
      expect(result.stdout).toContain("Fallback Author")
    })))

  it.effect("clears one typed cache identifier and reports missing on repeat", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "pmid-38903003", {
        id: "pmid:38903003",
        title: "Fixture PubMed Paper",
        authors: "Grace Hopper",
        url: "https://pubmed.ncbi.nlm.nih.gov/38903003/"
      }, "# Fixture PubMed Paper\n")

      const cleared = yield* runRootWith(cacheRoot, ["cache", "clear", "pmid:38903003"])
      const existsAfterClear = yield* pathExists(join(cacheRoot, "pmid-38903003", "meta.json"))
      const missing = yield* runRootWith(cacheRoot, ["cache", "clear", "pmid:38903003"])

      expect(cleared.exit._tag).toBe("Success")
      expect(cleared.stdout).toBe("Cleared cache for pmid:38903003")
      expect(existsAfterClear).toBe(false)
      expect(missing.exit._tag).toBe("Success")
      expect(missing.stdout).toBe("No cache entry for pmid:38903003")
    })))

  it.effect("normalizes URL identifiers at the cache clear CLI boundary", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "2401.04088", {
        id: "2401.04088",
        title: "Fixture Get Paper",
        authors: "Ada Lovelace",
        url: "https://arxiv.org/abs/2401.04088"
      }, "# Fixture Get Paper\n")

      const result = yield* runRootWith(cacheRoot, ["cache", "clear", "https://arxiv.org/abs/2401.04088v2"])
      const existsAfterClear = yield* pathExists(join(cacheRoot, "2401.04088", "meta.json"))

      expect(result.exit._tag).toBe("Success")
      expect(result.stdout).toBe("Cleared cache for 2401.04088")
      expect(existsAfterClear).toBe(false)
    })))

  it.effect("clears the full cache and reports missing when absent", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "2401.04088", {
        id: "2401.04088",
        title: "Fixture Get Paper",
        authors: "Ada Lovelace",
        url: "https://arxiv.org/abs/2401.04088"
      }, "# Fixture Get Paper\n")

      const cleared = yield* runRootWith(cacheRoot, ["cache", "clear"])
      const existsAfterClear = yield* pathExists(join(cacheRoot, "2401.04088", "meta.json"))
      const missing = yield* runRootWith(cacheRoot, ["cache", "clear"])

      expect(cleared.exit._tag).toBe("Success")
      expect(cleared.stdout).toBe("Cleared paper7 cache")
      expect(existsAfterClear).toBe(false)
      expect(missing.exit._tag).toBe("Success")
      expect(missing.stdout).toBe("No paper7 cache found")
    })))

  it.effect("full cache clear removes paper cache and search cache entries", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "2401.04088", {
        id: "2401.04088",
        title: "Fixture Get Paper",
        authors: "Ada Lovelace",
        url: "https://arxiv.org/abs/2401.04088"
      }, "# Fixture Get Paper\n")
      yield* writeSearchCacheEntry(cacheRoot, "arxiv")
      yield* writeSearchCacheEntry(cacheRoot, "pubmed")

      const cleared = yield* runRootWith(cacheRoot, ["cache", "clear"])
      const paperExistsAfter = yield* pathExists(join(cacheRoot, "2401.04088", "meta.json"))
      const arxivSearchExistsAfter = yield* searchCacheExists(cacheRoot, "arxiv")
      const pubmedSearchExistsAfter = yield* searchCacheExists(cacheRoot, "pubmed")

      expect(cleared.exit._tag).toBe("Success")
      expect(cleared.stdout).toBe("Cleared paper7 cache")
      expect(paperExistsAfter).toBe(false)
      expect(arxivSearchExistsAfter).toBe(false)
      expect(pubmedSearchExistsAfter).toBe(false)
    })))

  it.effect("per-paper cache clear removes only the requested paper and preserves search cache", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      yield* writeEntry(cacheRoot, "2401.04088", {
        id: "2401.04088",
        title: "Fixture Get Paper",
        authors: "Ada Lovelace",
        url: "https://arxiv.org/abs/2401.04088"
      }, "# Fixture Get Paper\n")
      yield* writeEntry(cacheRoot, "pmid-38903003", {
        id: "pmid:38903003",
        title: "Fixture PubMed Paper",
        authors: "Grace Hopper",
        url: "https://pubmed.ncbi.nlm.nih.gov/38903003/"
      }, "# Fixture PubMed Paper\n")
      yield* writeSearchCacheEntry(cacheRoot, "arxiv")
      yield* writeSearchCacheEntry(cacheRoot, "pubmed")

      const cleared = yield* runRootWith(cacheRoot, ["cache", "clear", "2401.04088"])
      const arxivPaperExistsAfter = yield* pathExists(join(cacheRoot, "2401.04088", "meta.json"))
      const pubmedPaperExistsAfter = yield* pathExists(join(cacheRoot, "pmid-38903003", "meta.json"))
      const arxivSearchExistsAfter = yield* searchCacheExists(cacheRoot, "arxiv")
      const pubmedSearchExistsAfter = yield* searchCacheExists(cacheRoot, "pubmed")

      expect(cleared.exit._tag).toBe("Success")
      expect(cleared.stdout).toBe("Cleared cache for 2401.04088")
      expect(arxivPaperExistsAfter).toBe(false)
      expect(pubmedPaperExistsAfter).toBe(true)
      expect(arxivSearchExistsAfter).toBe(true)
      expect(pubmedSearchExistsAfter).toBe(true)
    })))
})
