import { Effect, Option } from "effect"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ArxivSearchResult } from "./arxiv.js"
import { CachePaths, CacheFsError } from "./cache.js"
import type { PubmedSearchResult } from "./pubmed.js"
import type { SearchSort } from "./parser.js"

export const SEARCH_CACHE_TTL_MS = 86_400_000

export type SearchCacheSource = "arxiv" | "pubmed"

export type SearchCacheParams = {
  readonly source: SearchCacheSource
  readonly query: string
  readonly max: number
  readonly sort: SearchSort
}

export type NormalizedSearchCacheParams = {
  readonly source: SearchCacheSource
  readonly normalizedQuery: string
  readonly max: number
  readonly sort: SearchSort
}

export type SearchCachePayload<S extends SearchCacheSource> =
  S extends "arxiv" ? ArxivSearchResult : PubmedSearchResult

export type SearchCacheEnvelope<S extends SearchCacheSource = SearchCacheSource> = {
  readonly createdAt: number
  readonly ttlMs: number
  readonly params: NormalizedSearchCacheParams & { source: S }
  readonly payload: SearchCachePayload<S>
}

export const normalizeSearchQuery = (query: string): string =>
  query.trim().toLowerCase().replace(/\s+/g, " ")

const cacheKey = (params: NormalizedSearchCacheParams): string => {
  const hash = createHash("sha256")
  hash.update(params.source)
  hash.update(params.normalizedQuery)
  hash.update(String(params.max))
  hash.update(params.sort)
  return hash.digest("hex")
}

const cacheFilePath = (cacheRoot: string, params: NormalizedSearchCacheParams): string =>
  join(cacheRoot, "search", params.source, `${cacheKey(params)}.json`)

export function readSearchCache(
  params: SearchCacheParams & { source: "arxiv" }
): Effect.Effect<Option.Option<ArxivSearchResult>, CacheFsError, CachePaths>
export function readSearchCache(
  params: SearchCacheParams & { source: "pubmed" }
): Effect.Effect<Option.Option<PubmedSearchResult>, CacheFsError, CachePaths>
export function readSearchCache(
  params: SearchCacheParams
): Effect.Effect<Option.Option<ArxivSearchResult | PubmedSearchResult>, CacheFsError, CachePaths> {
  return Effect.gen(function*() {
    const paths = yield* CachePaths
    const normalized = normalizeSearchQuery(params.query)
    const normalizedParams: NormalizedSearchCacheParams = {
      source: params.source,
      normalizedQuery: normalized,
      max: params.max,
      sort: params.sort
    }
    const path = cacheFilePath(paths.cacheRoot, normalizedParams)

    const content = yield* Effect.tryPromise({
      try: () => readFile(path, { encoding: "utf8" }),
      catch: (cause: unknown): CacheFsError | undefined => {
        if (isMissing(cause)) return undefined
        return new CacheFsError({ message: "failed to read search cache", cause })
      }
    }).pipe(
      Effect.catch((error: CacheFsError | undefined) =>
        error === undefined ? Effect.succeed(undefined) : Effect.fail(error)
      )
    )

    if (content === undefined) return Option.none()

    const parsed = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: (cause: unknown): CacheFsError =>
        new CacheFsError({ message: "malformed search cache envelope", cause })
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))

    if (parsed === undefined) return Option.none()

    if (!isValidEnvelope(parsed)) return Option.none()

    if (
      parsed.params.source !== normalizedParams.source ||
      parsed.params.normalizedQuery !== normalizedParams.normalizedQuery ||
      parsed.params.max !== normalizedParams.max ||
      parsed.params.sort !== normalizedParams.sort
    ) {
      return Option.none()
    }

    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    if (now - parsed.createdAt > parsed.ttlMs) {
      return Option.none()
    }

    if (!isValidPayload(parsed.payload)) return Option.none()

    return Option.some(parsed.payload as SearchCachePayload<typeof params.source>)
  })
}

export function writeSearchCache(
  params: SearchCacheParams & { source: "arxiv" },
  payload: ArxivSearchResult
): Effect.Effect<void, CacheFsError, CachePaths>
export function writeSearchCache(
  params: SearchCacheParams & { source: "pubmed" },
  payload: PubmedSearchResult
): Effect.Effect<void, CacheFsError, CachePaths>
export function writeSearchCache(
  params: SearchCacheParams,
  payload: ArxivSearchResult | PubmedSearchResult
): Effect.Effect<void, CacheFsError, CachePaths> {
  return Effect.gen(function*() {
    const paths = yield* CachePaths
    const normalized = normalizeSearchQuery(params.query)
    const normalizedParams: NormalizedSearchCacheParams = {
      source: params.source,
      normalizedQuery: normalized,
      max: params.max,
      sort: params.sort
    }
    const path = cacheFilePath(paths.cacheRoot, normalizedParams)
    const dir = join(paths.cacheRoot, "search", params.source)

    const envelope: SearchCacheEnvelope<typeof params.source> = {
      createdAt: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
      ttlMs: SEARCH_CACHE_TTL_MS,
      params: normalizedParams,
      payload: payload as SearchCachePayload<typeof params.source>
    }

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(path, JSON.stringify(envelope), { encoding: "utf8" })
      },
      catch: (cause: unknown): CacheFsError =>
        new CacheFsError({ message: "failed to write search cache", cause })
    })
  })
}

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"

const isValidEnvelope = (value: unknown): value is SearchCacheEnvelope =>
  typeof value === "object" && value !== null &&
  typeof (value as Record<string, unknown>).createdAt === "number" &&
  typeof (value as Record<string, unknown>).ttlMs === "number" &&
  typeof (value as Record<string, unknown>).params === "object" &&
  (value as Record<string, unknown>).params !== null &&
  typeof (value as Record<string, unknown>).payload === "object" &&
  (value as Record<string, unknown>).payload !== null

const isValidPayload = (value: unknown): value is { total: number; papers: ReadonlyArray<unknown>; warnings: ReadonlyArray<unknown> } =>
  typeof value === "object" && value !== null &&
  typeof (value as Record<string, unknown>).total === "number" &&
  Array.isArray((value as Record<string, unknown>).papers) &&
  Array.isArray((value as Record<string, unknown>).warnings)
