import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
})
