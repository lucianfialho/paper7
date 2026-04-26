import { Effect } from "effect"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { cacheDirForIdentifier, listCachedPapers, type CacheError } from "./cache.js"
import { parsePaperIdentifier, type PaperIdentifier } from "./parser.js"

export type VaultError =
  | { readonly _tag: "VaultConfigMissing"; readonly message: string }
  | { readonly _tag: "VaultInvalidPath"; readonly message: string; readonly path: string }
  | { readonly _tag: "VaultCacheMissing"; readonly message: string; readonly id: string }
  | { readonly _tag: "VaultCacheMalformed"; readonly message: string; readonly id: string }
  | { readonly _tag: "VaultFsError"; readonly message: string; readonly cause: unknown }

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

export const initVault = (inputPath: string): Effect.Effect<VaultInitResult, VaultError> => {
  if (inputPath.trim() === "") {
    return Effect.fail({ _tag: "VaultInvalidPath", message: "invalid vault path: <empty>", path: inputPath })
  }

  const vaultPath = normalizePath(inputPath)
  return validateVaultPath(vaultPath).pipe(
    Effect.flatMap(() => writeVaultConfig(vaultPath)),
    Effect.as({ path: vaultPath })
  )
}

export const exportPaperToVault = (id: PaperIdentifier): Effect.Effect<VaultExportResult, VaultError> =>
  loadVaultPath().pipe(
    Effect.flatMap((vaultPath) => exportOne(vaultPath, id))
  )

export const exportAllPapersToVault = (): Effect.Effect<VaultExportAllResult, VaultError> =>
  loadVaultPath().pipe(
    Effect.flatMap((vaultPath) =>
      listCachedPapers().pipe(
        Effect.mapError(cacheToVaultError),
        Effect.flatMap((result) => {
          const exported = Effect.forEach(result.entries, (entry): Effect.Effect<VaultExportResult, VaultError> => {
            const id = parsePaperIdentifier(entry.id)
            if (id === undefined) {
              const error: VaultError = { _tag: "VaultCacheMalformed", message: `invalid cached paper id: ${entry.id}`, id: entry.id }
              return Effect.fail(error)
            }
            return exportOne(vaultPath, id)
          })
          return exported.pipe(Effect.map((written) => ({ count: written.length, path: vaultPath })))
        })
      )
    )
  )

const exportOne = (vaultPath: string, id: PaperIdentifier): Effect.Effect<VaultExportResult, VaultError> => {
  const formattedId = formatIdentifier(id)
  const cacheDir = cacheDirForIdentifier(id)
  return readCachedPaper(cacheDir, formattedId).pipe(
    Effect.flatMap(({ meta, markdown }) => {
      const target = safeTargetPath(vaultPath, formattedId)
      if (target === undefined) {
        const error: VaultError = { _tag: "VaultCacheMalformed", message: `unsafe export path for ${formattedId}`, id: formattedId }
        return Effect.fail(error)
      }
      return writeVaultPaper(target, meta, markdown).pipe(Effect.as({ id: formattedId, path: target }))
    })
  )
}

const loadVaultPath = (): Effect.Effect<string, VaultError> =>
  Effect.tryPromise({
    try: () => readFile(configPath(), { encoding: "utf8" }),
    catch: (cause): VaultError => isMissing(cause)
      ? { _tag: "VaultConfigMissing", message: "vault not configured; run paper7 vault init <path>" }
      : { _tag: "VaultFsError", message: "failed to read vault config", cause },
  }).pipe(
    Effect.flatMap((content) => {
      const path = parseVaultConfig(content)
      if (path === undefined) {
        const error: VaultError = { _tag: "VaultConfigMissing", message: "vault not configured; run paper7 vault init <path>" }
        return Effect.fail(error)
      }
      return validateVaultPath(path).pipe(Effect.as(path))
    })
  )

const writeVaultConfig = (vaultPath: string): Effect.Effect<void, VaultError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(configPath()), { recursive: true })
      await writeFile(configPath(), `PAPER7_VAULT=${vaultPath}\n`, { encoding: "utf8" })
    },
    catch: (cause): VaultError => ({ _tag: "VaultFsError", message: "failed to write vault config", cause }),
  })

const validateVaultPath = (vaultPath: string): Effect.Effect<void, VaultError> =>
  Effect.tryPromise({
    try: async () => {
      const info = await stat(vaultPath)
      if (!info.isDirectory()) throw new Error("not a directory")
    },
    catch: (): VaultError => ({ _tag: "VaultInvalidPath", message: `invalid vault path: ${vaultPath}`, path: vaultPath }),
  })

const readCachedPaper = (cacheDir: string, id: string): Effect.Effect<{ readonly meta: CacheMeta; readonly markdown: string }, VaultError> =>
  Effect.tryPromise({
    try: async () => {
      const markdown = await readFile(join(cacheDir, "paper.md"), { encoding: "utf8" })
      const meta = await readMeta(cacheDir, id)
      return { meta, markdown }
    },
    catch: (cause): VaultError => isMissing(cause)
      ? { _tag: "VaultCacheMissing", message: `no cached paper for ${id}`, id }
      : { _tag: "VaultFsError", message: `failed to read cached paper for ${id}`, cause },
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
    catch: (cause): VaultError => ({ _tag: "VaultFsError", message: `failed to write vault paper: ${target}`, cause }),
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

const configPath = (): string => join(homeDir(), ".paper7", "config")

const homeDir = (): string => process.env.HOME ?? "."

const yamlScalar = (input: string): string => /^[A-Za-z0-9._:/ -]+$/.test(input) ? input : JSON.stringify(input)

const cacheToVaultError = (error: CacheError): VaultError => ({ _tag: "VaultFsError", message: error.message, cause: error.cause })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value)

const stringValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
