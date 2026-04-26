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
import { VaultPaths } from "../src/vault.js"

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

const runRootWith = (cacheRoot: string, configPath: string, args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const program = Command.runWith(rootCommand, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(CachePaths, { cacheRoot }),
      Effect.provideService(VaultPaths, { configPath }),
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

const withTempVault = <A, E, R>(effect: (paths: { readonly root: string; readonly cacheRoot: string; readonly configPath: string; readonly vaultPath: string }) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "paper7-vault-"))),
    (root) => effect({
      root,
      cacheRoot: join(root, "cache"),
      configPath: join(root, "config", "paper7"),
      vaultPath: join(root, "Vault")
    }),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
  )

const writeEntry = (
  cacheRoot: string,
  dirname: string,
  meta: { readonly id: string; readonly title: string; readonly authors?: string; readonly url?: string },
  markdown: string
) =>
  Effect.promise(async () => {
    const dir = join(cacheRoot, dirname)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta), { encoding: "utf8" })
    await writeFile(join(dir, "paper.md"), markdown, { encoding: "utf8" })
  })

describe("vault commands", () => {
  it.effect("initializes vault config through Effect CLI", () =>
    withTempVault((paths) => Effect.gen(function*() {
      yield* Effect.promise(() => mkdir(paths.vaultPath, { recursive: true }))

      const result = yield* runRootWith(paths.cacheRoot, paths.configPath, ["vault", "init", paths.vaultPath])
      const config = yield* Effect.promise(() => readFile(paths.configPath, { encoding: "utf8" }))

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe(`Configured vault: ${paths.vaultPath}`)
      expect(config).toBe(`PAPER7_VAULT=${paths.vaultPath}\n`)
    })))

  it.effect("reports missing vault config", () =>
    withTempVault((paths) => Effect.gen(function*() {
      const result = yield* runRootWith(paths.cacheRoot, paths.configPath, ["vault", "2401.04088"])

      expect(result.exit._tag).toBe("Failure")
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("error: vault export failed: vault not configured; run paper7 vault init <path>")
    })))

  it.effect("reports missing cached paper", () =>
    withTempVault((paths) => Effect.gen(function*() {
      yield* Effect.promise(async () => {
        await mkdir(paths.vaultPath, { recursive: true })
        await mkdir(join(paths.configPath, ".."), { recursive: true })
        await writeFile(paths.configPath, `PAPER7_VAULT=${paths.vaultPath}\n`, { encoding: "utf8" })
      })

      const result = yield* runRootWith(paths.cacheRoot, paths.configPath, ["vault", "2401.99999"])

      expect(result.exit._tag).toBe("Failure")
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("error: vault export failed: no cached paper for 2401.99999")
    })))

  it.effect("reports invalid configured vault path", () =>
    withTempVault((paths) => Effect.gen(function*() {
      const invalidVaultPath = join(paths.root, "not-a-dir")
      yield* Effect.promise(async () => {
        await mkdir(join(paths.configPath, ".."), { recursive: true })
        await writeFile(paths.configPath, `PAPER7_VAULT=${invalidVaultPath}\n`, { encoding: "utf8" })
      })

      const result = yield* runRootWith(paths.cacheRoot, paths.configPath, ["vault", "2401.04088"])

      expect(result.exit._tag).toBe("Failure")
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe(`error: vault export failed: invalid vault path: ${invalidVaultPath}`)
    })))

  it.effect("rejects empty vault init path without writing config", () =>
    withTempVault((paths) => Effect.gen(function*() {
      const result = yield* runRootWith(paths.cacheRoot, paths.configPath, ["vault", "init", ""])
      const config = yield* Effect.promise(() => readFile(paths.configPath, { encoding: "utf8" }).catch((cause: unknown) => cause))

      expect(result.exit._tag).toBe("Failure")
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("error: vault export failed: invalid vault path: <empty>")
      expect(config).toBeInstanceOf(Error)
    })))

  it.effect("exports one cached paper without stdout trust markers", () =>
    withTempVault((paths) => Effect.gen(function*() {
      yield* Effect.promise(async () => {
        await mkdir(paths.vaultPath, { recursive: true })
        await mkdir(join(paths.configPath, ".."), { recursive: true })
        await writeFile(paths.configPath, `PAPER7_VAULT=${paths.vaultPath}\n`, { encoding: "utf8" })
      })
      yield* writeEntry(paths.cacheRoot, "2401.04088", {
        id: "2401.04088",
        title: "Fixture Get Paper",
        authors: "Ada Lovelace, Grace Hopper",
        url: "https://arxiv.org/abs/2401.04088"
      }, "# Fixture Get Paper\n\nBody.\n")

      const result = yield* runRootWith(paths.cacheRoot, paths.configPath, ["vault", "https://arxiv.org/abs/2401.04088v2"])
      const exported = yield* Effect.promise(() => readFile(join(paths.vaultPath, "2401.04088.md"), { encoding: "utf8" }))

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe(`Exported 2401.04088 to ${join(paths.vaultPath, "2401.04088.md")}`)
      expect(exported).toContain("paper7-id: 2401.04088")
      expect(exported).toContain("# Fixture Get Paper")
      expect(exported).not.toContain("<untrusted-content")
    })))

  it.effect("exports all cached papers with path-safe filenames", () =>
    withTempVault((paths) => Effect.gen(function*() {
      yield* Effect.promise(async () => {
        await mkdir(paths.vaultPath, { recursive: true })
        await mkdir(join(paths.configPath, ".."), { recursive: true })
        await writeFile(paths.configPath, `PAPER7_VAULT=${paths.vaultPath}\n`, { encoding: "utf8" })
      })
      yield* writeEntry(paths.cacheRoot, "2401.04088", { id: "2401.04088", title: "Fixture Get Paper" }, "# Fixture Get Paper\n")
      yield* writeEntry(paths.cacheRoot, "pmid-38903003", { id: "pmid:38903003", title: "Fixture PubMed Paper" }, "# Fixture PubMed Paper\n")
      yield* writeEntry(paths.cacheRoot, "doi-10.1101_2023.12.15.571821", { id: "doi:10.1101/2023.12.15.571821", title: "Unsafe / DOI: Paper" }, "# Unsafe / DOI: Paper\n")

      const result = yield* runRootWith(paths.cacheRoot, paths.configPath, ["vault", "all"])
      const arxiv = yield* Effect.promise(() => readFile(join(paths.vaultPath, "2401.04088.md"), { encoding: "utf8" }))
      const pubmed = yield* Effect.promise(() => readFile(join(paths.vaultPath, "pmid-38903003.md"), { encoding: "utf8" }))
      const doi = yield* Effect.promise(() => readFile(join(paths.vaultPath, "doi-10.1101_2023.12.15.571821.md"), { encoding: "utf8" }))

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe(`Exported 3 papers to ${paths.vaultPath}`)
      expect(arxiv).toContain("# Fixture Get Paper")
      expect(pubmed).toContain("# Fixture PubMed Paper")
      expect(doi).toContain("# Unsafe / DOI: Paper")
    })))
})
