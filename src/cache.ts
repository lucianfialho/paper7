import { Context, Effect, Layer } from "effect"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { PaperIdentifier } from "./parser.js"

export type CachePathsShape = {
  readonly cacheRoot: string
}

export class CachePaths extends Context.Service<CachePaths, CachePathsShape>()("paper7/CachePaths") {}

export const CachePathsLive = Layer.effect(CachePaths, Effect.sync(() => ({ cacheRoot: defaultCacheRoot() })))

export type CacheError = {
  readonly _tag: "CacheFsError"
  readonly message: string
  readonly cause: unknown
}

export type CacheEntry = {
  readonly id: string
  readonly title: string
  readonly authors?: string
  readonly url?: string
}

export type CacheListResult = {
  readonly entries: ReadonlyArray<CacheEntry>
  readonly warnings: ReadonlyArray<string>
}

export type CacheClearResult =
  | { readonly _tag: "cleared-all" }
  | { readonly _tag: "cleared-one"; readonly id: string }
  | { readonly _tag: "missing"; readonly id?: string }

type CacheKind = "arxiv" | "pubmed" | "doi" | "unknown"

type CacheMeta = {
  readonly id: string
  readonly title: string
  readonly authors?: string
  readonly url?: string
}

type DecodedMeta =
  | { readonly _tag: "ok"; readonly meta: CacheMeta }
  | { readonly _tag: "missing" }
  | { readonly _tag: "malformed" }

export const listCachedPapers = (): Effect.Effect<CacheListResult, CacheError, CachePaths> =>
  CachePaths.use((paths) => listCachedPapersAt(paths.cacheRoot))

const listCachedPapersAt = (cache: string): Effect.Effect<CacheListResult, CacheError> =>
  Effect.tryPromise({
    try: async () => {
      const dirs = await readdir(cache, { withFileTypes: true }).catch((cause: unknown) => {
        if (isMissing(cause)) return []
        throw cause
      })

      const entries: Array<CacheEntry> = []
      const warnings: Array<string> = []

      for (const dirent of dirs) {
        if (!dirent.isDirectory()) continue
        const dirname = dirent.name
        const kind = kindFromDir(dirname)
        const dir = join(cache, dirname)
        const meta = await readMeta(dir)
        const paper = await readPaperMarkdown(dir)

        if (meta._tag === "malformed") warnings.push(`warning: skipping malformed metadata in ${dirname}`)

        const entry = entryFromCache(dirname, kind, meta, paper)
        if (entry === undefined) {
          if (kind === "doi") warnings.push(`warning: skipping DOI cache without readable metadata in ${dirname}`)
          continue
        }
        entries.push(entry)
      }

      return { entries: entries.sort(compareEntries), warnings }
    },
    catch: (cause): CacheError => ({ _tag: "CacheFsError", message: "failed to list cache", cause }),
  })

export const clearCachedPapers = (id: PaperIdentifier | undefined): Effect.Effect<CacheClearResult, CacheError, CachePaths> =>
  CachePaths.use((paths) => {
    if (id === undefined) return clearAllCachedPapers(paths.cacheRoot)
    return clearOneCachedPaper(paths.cacheRoot, id)
  })

export const writeCacheMeta = (
  dir: string,
  id: string,
  title: string,
  authors: ReadonlyArray<string>,
  url: string
): Effect.Effect<void, CacheError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "meta.json"), JSON.stringify({ id, title, authors: authors.join(", "), url }), { encoding: "utf8" })
    },
    catch: (cause): CacheError => ({ _tag: "CacheFsError", message: "failed to write cache metadata", cause }),
  })

export const cacheDirForIdentifier = (id: PaperIdentifier): string => {
  switch (id.tag) {
    case "arxiv":
      return cacheDir(id.id)
    case "pubmed":
      return cacheDir(`pmid-${id.id}`)
    case "doi":
      return cacheDir(`doi-${safeDoiDir(id.id)}`)
  }
}

export const cacheDir = (id: string): string => join(cacheRoot(), id)

export const safeDoiDir = (doi: string): string => doi.replace(/\//g, "_").replace(/[^A-Za-z0-9._-]/g, "_")

const clearAllCachedPapers = (cache: string): Effect.Effect<CacheClearResult, CacheError> =>
  Effect.tryPromise({
    try: async () => {
      const present = await exists(cache)
      if (!present) return { _tag: "missing" }
      await rm(cache, { recursive: true, force: true })
      return { _tag: "cleared-all" }
    },
    catch: (cause): CacheError => ({ _tag: "CacheFsError", message: "failed to clear cache", cause }),
  })

const clearOneCachedPaper = (cache: string, id: PaperIdentifier): Effect.Effect<CacheClearResult, CacheError> =>
  Effect.tryPromise({
    try: async () => {
      const dir = cacheDirForIdentifierAt(cache, id)
      const resultId = formatIdentifier(id)
      const present = await exists(dir)
      if (!present) return { _tag: "missing", id: resultId }
      await rm(dir, { recursive: true, force: true })
      return { _tag: "cleared-one", id: resultId }
    },
    catch: (cause): CacheError => ({ _tag: "CacheFsError", message: "failed to clear cache", cause }),
  })

const cacheRoot = (): string => defaultCacheRoot()

const defaultCacheRoot = (): string => join(process.env.HOME ?? ".", ".paper7", "cache")

export const cacheDirForIdentifierAt = (cache: string, id: PaperIdentifier): string => {
  switch (id.tag) {
    case "arxiv":
      return join(cache, id.id)
    case "pubmed":
      return join(cache, `pmid-${id.id}`)
    case "doi":
      return join(cache, `doi-${safeDoiDir(id.id)}`)
  }
}

const kindFromDir = (dirname: string): CacheKind => {
  if (/^\d{4}\.\d{4,5}$/.test(dirname)) return "arxiv"
  if (/^pmid-\d+$/.test(dirname)) return "pubmed"
  if (dirname.startsWith("doi-")) return "doi"
  return "unknown"
}

const readMeta = async (dir: string): Promise<DecodedMeta> => {
  const content = await readFile(join(dir, "meta.json"), { encoding: "utf8" }).catch((cause: unknown) => {
    if (isMissing(cause)) return undefined
    throw cause
  })
  if (content === undefined) return { _tag: "missing" }

  try {
    const parsed: unknown = JSON.parse(content)
    const record = getRecord(parsed)
    if (record === undefined) return { _tag: "malformed" }
    const id = getString(record.id)
    const title = getString(record.title)
    if (id === undefined || title === undefined) return { _tag: "malformed" }
    return { _tag: "ok", meta: { id, title, authors: getString(record.authors), url: getString(record.url) } }
  } catch {
    return { _tag: "malformed" }
  }
}

const readPaperMarkdown = async (dir: string): Promise<string | undefined> =>
  readFile(join(dir, "paper.md"), { encoding: "utf8" }).catch((cause: unknown) => {
    if (isMissing(cause)) return undefined
    throw cause
  })

const entryFromCache = (dirname: string, kind: CacheKind, meta: DecodedMeta, markdown: string | undefined): CacheEntry | undefined => {
  if (meta._tag === "ok") return meta.meta
  if (kind === "doi") return undefined
  const id = fallbackId(dirname, kind)
  if (id === undefined) return undefined
  return { id, title: titleFromMarkdown(markdown) ?? "Untitled", authors: authorsFromMarkdown(markdown), url: urlFromMarkdown(markdown) }
}

const fallbackId = (dirname: string, kind: CacheKind): string | undefined => {
  switch (kind) {
    case "arxiv":
      return dirname
    case "pubmed":
      return `pmid:${dirname.slice("pmid-".length)}`
    case "doi":
    case "unknown":
      return undefined
  }
}

const titleFromMarkdown = (markdown: string | undefined): string | undefined => {
  if (markdown === undefined) return undefined
  const firstLine = markdown.split("\n")[0]
  if (firstLine === undefined) return undefined
  const title = firstLine.replace(/^#\s+/, "").trim()
  return title === "" ? undefined : title
}

const authorsFromMarkdown = (markdown: string | undefined): string | undefined => fieldFromMarkdown(markdown, "Authors")

const urlFromMarkdown = (markdown: string | undefined): string | undefined =>
  fieldFromMarkdown(markdown, "arXiv") ?? fieldFromMarkdown(markdown, "PubMed") ?? fieldFromMarkdown(markdown, "Full text")

const fieldFromMarkdown = (markdown: string | undefined, label: string): string | undefined => {
  if (markdown === undefined) return undefined
  const prefix = `**${label}:** `
  for (const line of markdown.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim()
  }
  return undefined
}

const compareEntries = (left: CacheEntry, right: CacheEntry): number => left.id.localeCompare(right.id)

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

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    (cause: unknown) => !isMissing(cause)
  )

const getRecord = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const getString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
