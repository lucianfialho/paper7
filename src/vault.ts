import { Context, Data, Effect, Layer } from "effect"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { cacheDirForIdentifierAt, listCachedPapers, type CacheError, CachePaths, type CachePaths as CachePathsContext } from "./cache.js"
import { parsePaperIdentifier, type PaperIdentifier } from "./parser.js"

export type VaultPathsShape = {
  readonly configPath: string
}

export class VaultPaths extends Context.Service<VaultPaths, VaultPathsShape>()("paper7/VaultPaths") {}

export const VaultPathsLive = Layer.effect(VaultPaths, Effect.sync(() => ({ configPath: defaultConfigPath() })))

export class VaultConfigMissing extends Data.TaggedError("VaultConfigMissing")<{
  readonly message: string
}> {}

export class VaultInvalidPath extends Data.TaggedError("VaultInvalidPath")<{
  readonly message: string
  readonly path: string
}> {}

export class VaultCacheMissing extends Data.TaggedError("VaultCacheMissing")<{
  readonly message: string
  readonly id: string
}> {}

export class VaultCacheMalformed extends Data.TaggedError("VaultCacheMalformed")<{
  readonly message: string
  readonly id: string
}> {}

export class VaultFsError extends Data.TaggedError("VaultFsError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export type VaultError =
  | VaultConfigMissing
  | VaultInvalidPath
  | VaultCacheMissing
  | VaultCacheMalformed
  | VaultFsError

export type VaultInitResult = {
  readonly path: string
}

export type VaultExportResult = {
  readonly id: string
  readonly path: string
}

export type VaultExportAllResult = {
  readonly count: number
  readonly path: string
}

type CacheMeta = {
  readonly id: string
  readonly title: string
  readonly authors?: string
  readonly url?: string
}

export const initVault = (inputPath: string): Effect.Effect<VaultInitResult, VaultError, VaultPaths> => {
  if (inputPath.trim() === "") {
    return Effect.fail(new VaultInvalidPath({ message: "invalid vault path: <empty>", path: inputPath }))
  }

  const vaultPath = normalizePath(inputPath)
  return validateVaultPath(vaultPath).pipe(
    Effect.flatMap(() => writeVaultConfig(vaultPath)),
    Effect.as({ path: vaultPath })
  )
}

export const exportPaperToVault = (id: PaperIdentifier): Effect.Effect<VaultExportResult, VaultError, VaultPaths | CachePathsContext> =>
  loadVaultPath().pipe(
    Effect.flatMap((vaultPath) => exportOne(vaultPath, id))
  )

export const exportAllPapersToVault = (): Effect.Effect<VaultExportAllResult, VaultError, VaultPaths | CachePathsContext> =>
  loadVaultPath().pipe(
    Effect.flatMap((vaultPath) =>
      listCachedPapers().pipe(
        Effect.mapError(cacheToVaultError),
        Effect.flatMap((result) => {
          const exported = Effect.forEach(result.entries, (entry): Effect.Effect<VaultExportResult, VaultError, CachePathsContext> => {
            const id = parsePaperIdentifier(entry.id)
            if (id === undefined) {
              return Effect.fail(new VaultCacheMalformed({ message: `invalid cached paper id: ${entry.id}`, id: entry.id }))
            }
            return exportOne(vaultPath, id)
          })
          return exported.pipe(Effect.map((written) => ({ count: written.length, path: vaultPath })))
        })
      )
    )
  )

const exportOne = (vaultPath: string, id: PaperIdentifier): Effect.Effect<VaultExportResult, VaultError, CachePathsContext> => {
  const formattedId = formatIdentifier(id)
  return CachePaths.use((paths) => readCachedPaper(cacheDirForIdentifierAt(paths.cacheRoot, id), formattedId)).pipe(
    Effect.flatMap(({ meta, markdown }) => {
      const target = safeTargetPath(vaultPath, formattedId)
      if (target === undefined) {
        return Effect.fail(new VaultCacheMalformed({ message: `unsafe export path for ${formattedId}`, id: formattedId }))
      }
      return writeVaultPaper(target, meta, markdown).pipe(Effect.as({ id: formattedId, path: target }))
    })
  )
}

const loadVaultPath = (): Effect.Effect<string, VaultError, VaultPaths> =>
  VaultPaths.use((paths) =>
    Effect.tryPromise({
      try: () => readFile(paths.configPath, { encoding: "utf8" }),
      catch: (cause): VaultError => isMissing(cause)
        ? new VaultConfigMissing({ message: "vault not configured; run paper7 vault init <path>" })
        : new VaultFsError({ message: "failed to read vault config", cause }),
    }).pipe(
      Effect.flatMap((content) => {
        const path = parseVaultConfig(content)
        if (path === undefined) {
          return Effect.fail(new VaultConfigMissing({ message: "vault not configured; run paper7 vault init <path>" }))
        }
        return validateVaultPath(path).pipe(Effect.as(path))
      })
    )
  )

const writeVaultConfig = (vaultPath: string): Effect.Effect<void, VaultError, VaultPaths> =>
  VaultPaths.use((paths) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(paths.configPath), { recursive: true })
        await writeFile(paths.configPath, `PAPER7_VAULT=${vaultPath}\n`, { encoding: "utf8" })
      },
      catch: (cause): VaultError => new VaultFsError({ message: "failed to write vault config", cause }),
    })
  )

const validateVaultPath = (vaultPath: string): Effect.Effect<void, VaultError> =>
  Effect.tryPromise({
    try: async () => {
      const info = await stat(vaultPath)
      if (!info.isDirectory()) throw new Error("not a directory")
    },
    catch: (): VaultError => new VaultInvalidPath({ message: `invalid vault path: ${vaultPath}`, path: vaultPath }),
  })

const readCachedPaper = (cacheDir: string, id: string): Effect.Effect<{ readonly meta: CacheMeta; readonly markdown: string }, VaultError> =>
  Effect.tryPromise({
    try: async () => {
      const markdown = await readFile(join(cacheDir, "paper.md"), { encoding: "utf8" })
      const meta = await readMeta(cacheDir, id)
      return { meta, markdown }
    },
    catch: (cause): VaultError => isMissing(cause)
      ? new VaultCacheMissing({ message: `no cached paper for ${id}`, id })
      : new VaultFsError({ message: `failed to read cached paper for ${id}`, cause }),
  })

const readMeta = async (cacheDir: string, id: string): Promise<CacheMeta> => {
  const content = await readFile(join(cacheDir, "meta.json"), { encoding: "utf8" }).catch((cause: unknown) => {
    if (isMissing(cause)) return undefined
    throw cause
  })
  if (content === undefined) return { id, title: "Untitled" }

  try {
    const parsed: unknown = JSON.parse(content)
    if (!isRecord(parsed)) return { id, title: "Untitled" }
    const metaId = stringValue(parsed.id) ?? id
    const title = stringValue(parsed.title) ?? "Untitled"
    return { id: metaId, title, authors: stringValue(parsed.authors), url: stringValue(parsed.url) }
  } catch {
    return { id, title: "Untitled" }
  }
}

const writeVaultPaper = (target: string, meta: CacheMeta, markdown: string): Effect.Effect<void, VaultError> =>
  Effect.tryPromise({
    try: () => writeFile(target, `${frontmatter(meta)}\n${markdown.trimEnd()}\n`, { encoding: "utf8" }),
      catch: (cause): VaultError => new VaultFsError({ message: `failed to write vault paper: ${target}`, cause }),
  })

const frontmatter = (meta: CacheMeta): string => [
  "---",
  `paper7-id: ${yamlScalar(meta.id)}`,
  `title: ${yamlScalar(meta.title)}`,
  ...(meta.authors === undefined ? [] : [`authors: ${yamlScalar(meta.authors)}`]),
  ...(meta.url === undefined ? [] : [`url: ${yamlScalar(meta.url)}`]),
  "---",
].join("\n")

const safeTargetPath = (vaultPath: string, id: string): string | undefined => {
  const target = resolve(vaultPath, `${safeFileStem(id)}.md`)
  const vaultRoot = resolve(vaultPath)
  if (target === vaultRoot) return undefined
  if (!target.startsWith(`${vaultRoot}/`)) return undefined
  return target
}

const safeFileStem = (id: string): string => id.replace(/^doi:/, "doi-").replace(/^pmid:/, "pmid-").replace(/[^A-Za-z0-9._-]/g, "_")

const formatIdentifier = (id: PaperIdentifier): string => {
  switch (id.tag) {
    case "arxiv":
      return id.id
    case "pubmed":
      return `pmid:${id.id}`
    case "doi":
      return `doi:${id.id}`
  }
}

const parseVaultConfig = (content: string): string | undefined => {
  for (const line of content.split("\n")) {
    if (line.startsWith("PAPER7_VAULT=")) {
      const path = line.slice("PAPER7_VAULT=".length).trim()
      return path === "" ? undefined : path
    }
  }
  return undefined
}

const normalizePath = (inputPath: string): string => {
  if (inputPath === "~") return homeDir()
  if (inputPath.startsWith("~/")) return resolve(homeDir(), inputPath.slice(2))
  return resolve(inputPath)
}

const defaultConfigPath = (): string => join(homeDir(), ".paper7", "config")

const homeDir = (): string => process.env.HOME ?? "."

const yamlScalar = (input: string): string => /^[A-Za-z0-9._:/ -]+$/.test(input) ? input : JSON.stringify(input)

const cacheToVaultError = (error: CacheError): VaultError => new VaultFsError({ message: error.message, cause: error.cause })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value)

const stringValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
