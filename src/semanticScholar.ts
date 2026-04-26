import { Context, Effect, Layer } from "effect"
import type { Input as DurationInput } from "effect/Duration"
import { readFile } from "node:fs/promises"
import type { PaperIdentifier } from "./parser.js"

const S2_API_URL = "https://api.semanticscholar.org/graph/v1"
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY: DurationInput = "150 millis"

export type S2Reference = {
  readonly id: string
  readonly title: string
  readonly authors: ReadonlyArray<string>
  readonly year?: number | string
}

export type S2ReferencesResult = {
  readonly data: ReadonlyArray<S2Reference>
  readonly warnings: ReadonlyArray<string>
}

export type S2RefsParams = {
  readonly id: PaperIdentifier
  readonly max: number
}

export type SemanticScholarError =
  | { readonly _tag: "SemanticScholarHttpError"; readonly status: number; readonly message: string }
  | { readonly _tag: "SemanticScholarNotFoundError"; readonly message: string }
  | { readonly _tag: "SemanticScholarRateLimitError"; readonly message: string; readonly retryAfter?: string }
  | { readonly _tag: "SemanticScholarTransientError"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "SemanticScholarTimeoutError"; readonly message: string }
  | { readonly _tag: "SemanticScholarDecodeError"; readonly message: string }

export type SemanticScholarClientShape = {
  readonly references: (params: S2RefsParams) => Effect.Effect<S2ReferencesResult, SemanticScholarError>
}

export class SemanticScholarClient extends Context.Service<SemanticScholarClient, SemanticScholarClientShape>()("paper7/SemanticScholarClient") {}

type FetchInit = {
  readonly signal: AbortSignal
}

type FetchLike = (url: string, init: FetchInit) => Promise<Response>

type SemanticScholarClientOptions = {
  readonly apiUrl?: string
  readonly refsFixturePath?: string
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
  readonly retries?: number
  readonly retryDelay?: DurationInput
}

export const makeSemanticScholarClient = (options: SemanticScholarClientOptions = {}): SemanticScholarClientShape => {
  const apiUrl = options.apiUrl ?? S2_API_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY

  return {
    references: (params) => {
      const json = loadReferencesJson({
        fixturePath: options.refsFixturePath,
        url: buildReferencesUrl(apiUrl, params),
        fetchImpl,
        timeoutMs,
      })

      return retryTransient(json, retries, retryDelay).pipe(Effect.flatMap((body) => decodeReferences(body, params.max)))
    },
  }
}

export const SemanticScholarLive = Layer.succeed(
  SemanticScholarClient,
  makeSemanticScholarClient({ refsFixturePath: process.env.PAPER7_S2_REFS_FIXTURE })
)

export const decodeReferences = (json: string, max: number): Effect.Effect<S2ReferencesResult, SemanticScholarError> => {
  const parsed = parseJson(json)
  if (parsed._tag === "error") return Effect.fail(parsed.error)

  const root = getRecord(parsed.value)
  const data = root === undefined ? undefined : getArray(root.data)
  if (data === undefined) {
    return Effect.fail({ _tag: "SemanticScholarDecodeError", message: "Semantic Scholar references response missing data" })
  }

  const references: Array<S2Reference> = []
  const warnings: Array<string> = []
  for (const item of data.slice(0, max)) {
    const decoded = decodeReference(item)
    if (decoded._tag === "reference") {
      references.push(decoded.reference)
    } else {
      warnings.push(decoded.message)
    }
  }

  return Effect.succeed({ data: references, warnings })
}

const loadReferencesJson = (input: {
  readonly fixturePath: string | undefined
  readonly url: string
  readonly fetchImpl: FetchLike
  readonly timeoutMs: number
}): Effect.Effect<string, SemanticScholarError> => {
  const fixturePath = input.fixturePath
  if (fixturePath !== undefined) {
    return Effect.tryPromise({
      try: () => readFile(fixturePath, { encoding: "utf8" }),
      catch: (cause): SemanticScholarError => ({ _tag: "SemanticScholarTransientError", message: "failed to read Semantic Scholar fixture", cause }),
    })
  }

  const request: Effect.Effect<Response, SemanticScholarError> = Effect.tryPromise({
    try: (signal) => fetchWithTimeout(input.fetchImpl, input.url, signal, input.timeoutMs),
    catch: (cause): SemanticScholarError => isAbortError(cause)
      ? { _tag: "SemanticScholarTimeoutError", message: `Semantic Scholar request timed out after ${input.timeoutMs}ms` }
      : { _tag: "SemanticScholarTransientError", message: "Semantic Scholar request failed", cause },
  })

  return request.pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.tryPromise({
          try: () => response.text(),
          catch: (cause): SemanticScholarError => ({ _tag: "SemanticScholarTransientError", message: "failed to read Semantic Scholar response", cause }),
        })
      }

      if (response.status === 404) {
        const error: SemanticScholarError = {
          _tag: "SemanticScholarNotFoundError",
          message: "no paper found on Semantic Scholar",
        }
        return Effect.fail(error)
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after") ?? undefined
        const error: SemanticScholarError = retryAfter === undefined
          ? { _tag: "SemanticScholarRateLimitError", message: "Semantic Scholar rate limit exceeded" }
          : { _tag: "SemanticScholarRateLimitError", message: "Semantic Scholar rate limit exceeded", retryAfter }
        return Effect.fail(error)
      }

      if (response.status === 408 || response.status >= 500) {
        const error: SemanticScholarError = {
          _tag: "SemanticScholarTransientError",
          message: `Semantic Scholar transient HTTP ${response.status}`,
          cause: response.status,
        }
        return Effect.fail(error)
      }

      const error: SemanticScholarError = {
        _tag: "SemanticScholarHttpError",
        status: response.status,
        message: `Semantic Scholar HTTP ${response.status}`,
      }
      return Effect.fail(error)
    })
  )
}

const retryTransient = <A>(
  effect: Effect.Effect<A, SemanticScholarError>,
  remaining: number,
  retryDelay: DurationInput
): Effect.Effect<A, SemanticScholarError> =>
  effect.pipe(
    Effect.catch((error) => {
      if (error._tag === "SemanticScholarTransientError" && remaining > 0) {
        return Effect.sleep(retryDelay).pipe(Effect.andThen(retryTransient(effect, remaining - 1, retryDelay)))
      }
      return Effect.fail(error)
    })
  )

const fetchWithTimeout = (
  fetchImpl: FetchLike,
  url: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  signal.addEventListener("abort", abort, { once: true })
  return fetchImpl(url, { signal: controller.signal }).finally(() => {
    clearTimeout(timeout)
    signal.removeEventListener("abort", abort)
  })
}

const buildReferencesUrl = (apiUrl: string, params: S2RefsParams): string => {
  const url = new URL(`${apiUrl}/paper/${encodeURIComponent(s2PaperId(params.id))}/references`)
  url.searchParams.set("fields", "externalIds,title,authors,year")
  url.searchParams.set("limit", String(params.max))
  url.searchParams.set("tool", "paper7")
  return url.toString()
}

const s2PaperId = (id: PaperIdentifier): string => {
  switch (id.tag) {
    case "arxiv":
      return `arXiv:${id.id}`
    case "pubmed":
      return `PMID:${id.id}`
    case "doi":
      return `DOI:${id.id}`
  }
}

const decodeReference = (value: unknown):
  | { readonly _tag: "reference"; readonly reference: S2Reference }
  | { readonly _tag: "warning"; readonly message: string } => {
  const item = getRecord(value)
  const paper = item === undefined ? undefined : getRecord(item.citedPaper)
  if (paper === undefined) return { _tag: "warning", message: "Semantic Scholar partial failure: skipped malformed reference" }

  const id = referenceId(paper.externalIds, paper.paperId)
  const title = getString(paper.title) ?? "(no title)"
  const authors = authorNames(paper.authors)
  const year = getYear(paper.year)
  return year === undefined
    ? { _tag: "reference", reference: { id, title, authors } }
    : { _tag: "reference", reference: { id, title, authors, year } }
}

const referenceId = (externalIds: unknown, paperId: unknown): string => {
  const ids = getRecord(externalIds)
  if (ids !== undefined) {
    const arxiv = getString(ids.ArXiv)
    if (arxiv !== undefined) return `arxiv:${arxiv}`
    const pubmed = getStringOrNumber(ids.PubMed)
    if (pubmed !== undefined) return `pmid:${pubmed}`
    const doi = getString(ids.DOI)
    if (doi !== undefined) return `doi:${doi}`
  }
  return typeof paperId === "string" ? `s2:${paperId}` : "s2:unknown"
}

const authorNames = (authors: unknown): ReadonlyArray<string> => {
  const values = getArray(authors)
  if (values === undefined) return []

  const names: Array<string> = []
  for (const value of values) {
    const author = getRecord(value)
    const name = author === undefined ? undefined : getString(author.name)
    if (name !== undefined) names.push(name)
  }
  return names
}

const parseJson = (json: string):
  | { readonly _tag: "ok"; readonly value: unknown }
  | { readonly _tag: "error"; readonly error: SemanticScholarError } => {
  try {
    return { _tag: "ok", value: JSON.parse(json) }
  } catch {
    return { _tag: "error", error: { _tag: "SemanticScholarDecodeError", message: "failed to decode Semantic Scholar references" } }
  }
}

const getRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined => isRecord(value) ? value : undefined

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const getArray = (value: unknown): ReadonlyArray<unknown> | undefined => Array.isArray(value) ? value : undefined

const getString = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined

const getStringOrNumber = (value: unknown): string | undefined => {
  if (typeof value === "string" && value !== "") return value
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
  return undefined
}

const getYear = (value: unknown): number | string | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  if (typeof value === "string" && value !== "") return value
  return undefined
}

const isAbortError = (cause: unknown): boolean => cause instanceof Error && cause.name === "AbortError"
