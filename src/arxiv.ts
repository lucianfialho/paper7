import { Context, Effect, Layer } from "effect"
import type { Input as DurationInput } from "effect/Duration"
import { readFile } from "node:fs/promises"
import type { SearchSort } from "./parser.js"

const ARXIV_API_URL = "https://export.arxiv.org/api/query"
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY: DurationInput = "150 millis"

export type ArxivPaper = {
  readonly id: string
  readonly title: string
  readonly authors: ReadonlyArray<string>
  readonly published: string
}

export type ArxivSearchResult = {
  readonly total: number
  readonly papers: ReadonlyArray<ArxivPaper>
  readonly warnings: ReadonlyArray<string>
}

export type ArxivSearchParams = {
  readonly query: string
  readonly max: number
  readonly sort: SearchSort
}

export type ArxivError =
  | { readonly _tag: "ArxivHttpError"; readonly status: number; readonly message: string }
  | { readonly _tag: "ArxivTransientError"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "ArxivTimeoutError"; readonly message: string }
  | { readonly _tag: "ArxivDecodeError"; readonly message: string }

export type ArxivClientShape = {
  readonly search: (params: ArxivSearchParams) => Effect.Effect<ArxivSearchResult, ArxivError>
}

export class ArxivClient extends Context.Service<ArxivClient, ArxivClientShape>()("paper7/ArxivClient") {}

type FetchInit = {
  readonly signal: AbortSignal
}

type FetchLike = (url: string, init: FetchInit) => Promise<Response>

type ArxivClientOptions = {
  readonly apiUrl?: string
  readonly fixturePath?: string
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
  readonly retries?: number
  readonly retryDelay?: DurationInput
}

export const makeArxivClient = (options: ArxivClientOptions = {}): ArxivClientShape => {
  const apiUrl = options.apiUrl ?? ARXIV_API_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY

  return {
    search: (params) => {
      const fixturePath = options.fixturePath
      const loadFeed: Effect.Effect<string, ArxivError> = fixturePath === undefined
        ? requestFeed({ apiUrl, fetchImpl, params, timeoutMs })
        : Effect.tryPromise({
            try: () => readFile(fixturePath, { encoding: "utf8" }),
            catch: (cause): ArxivError => ({ _tag: "ArxivTransientError", message: "failed to read arXiv fixture", cause }),
          })

      return retryTransient(loadFeed, retries, retryDelay).pipe(Effect.flatMap((feed) => decodeArxivFeed(feed)))
    },
  }
}

export const ArxivLive = Layer.succeed(
  ArxivClient,
  makeArxivClient({ fixturePath: process.env.PAPER7_ARXIV_FIXTURE })
)

export const decodeArxivFeed = (xml: string): Effect.Effect<ArxivSearchResult, ArxivError> => {
  const totalText = firstTag(xml, "opensearch:totalResults")
  if (totalText === undefined) {
    return Effect.fail({ _tag: "ArxivDecodeError", message: "arXiv response missing totalResults" })
  }

  const total = Number(totalText.trim())
  if (!Number.isSafeInteger(total) || total < 0) {
    return Effect.fail({ _tag: "ArxivDecodeError", message: "arXiv response has invalid totalResults" })
  }

  const entries = tagBlocks(xml, "entry")
  const papers: Array<ArxivPaper> = []
  const warnings: Array<string> = []
  for (const entry of entries) {
    const decoded = decodeEntry(entry)
    if (decoded._tag === "paper") {
      papers.push(decoded.paper)
    } else {
      warnings.push(decoded.message)
    }
  }

  return Effect.succeed({ total, papers, warnings })
}

const requestFeed = (input: {
  readonly apiUrl: string
  readonly fetchImpl: FetchLike
  readonly params: ArxivSearchParams
  readonly timeoutMs: number
}): Effect.Effect<string, ArxivError> => {
  const url = buildSearchUrl(input.apiUrl, input.params)
  const request: Effect.Effect<Response, ArxivError> = Effect.tryPromise({
    try: (signal) => fetchWithTimeout(input.fetchImpl, url, signal, input.timeoutMs),
    catch: (cause): ArxivError => isAbortError(cause)
      ? { _tag: "ArxivTimeoutError", message: `arXiv request timed out after ${input.timeoutMs}ms` }
      : { _tag: "ArxivTransientError", message: "arXiv request failed", cause },
  })

  return request.pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.tryPromise({
          try: () => response.text(),
          catch: (cause): ArxivError => ({ _tag: "ArxivTransientError", message: "failed to read arXiv response", cause }),
        })
      }

      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        const error: ArxivError = {
          _tag: "ArxivTransientError",
          message: `arXiv transient HTTP ${response.status}`,
          cause: response.status,
        }
        return Effect.fail(error)
      }

      const error: ArxivError = {
        _tag: "ArxivHttpError",
        status: response.status,
        message: `arXiv HTTP ${response.status}`,
      }
      return Effect.fail(error)
    })
  )
}

const retryTransient = <A>(
  effect: Effect.Effect<A, ArxivError>,
  remaining: number,
  retryDelay: DurationInput
): Effect.Effect<A, ArxivError> =>
  effect.pipe(
    Effect.catch((error) => {
      if (error._tag === "ArxivTransientError" && remaining > 0) {
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

const buildSearchUrl = (apiUrl: string, params: ArxivSearchParams): string => {
  const url = new URL(apiUrl)
  url.searchParams.set("search_query", `all:${params.query}`)
  url.searchParams.set("start", "0")
  url.searchParams.set("max_results", String(params.max))
  url.searchParams.set("sortBy", params.sort === "date" ? "submittedDate" : "relevance")
  url.searchParams.set("sortOrder", "descending")
  return url.toString()
}

const decodeEntry = (entry: string):
  | { readonly _tag: "paper"; readonly paper: ArxivPaper }
  | { readonly _tag: "warning"; readonly message: string } => {
  const rawId = firstTag(entry, "id")
  const title = cleanText(firstTag(entry, "title"))
  const publishedText = firstTag(entry, "published")
  const authors = tagBlocks(entry, "author")
    .map((author) => cleanText(firstTag(author, "name")))
    .filter((name) => name !== undefined)

  const id = rawId === undefined ? undefined : normalizeArxivId(rawId.trim())
  const published = publishedText === undefined ? undefined : publishedText.trim().slice(0, 10)

  if (id === undefined || title === undefined || published === undefined) {
    return { _tag: "warning", message: "arXiv partial failure: skipped malformed result" }
  }

  return { _tag: "paper", paper: { id, title, authors, published } }
}

const tagBlocks = (xml: string, tag: string): ReadonlyArray<string> => {
  const results: Array<string> = []
  const pattern = new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRegExp(tag)}>`, "g")
  let match = pattern.exec(xml)
  while (match !== null) {
    const body = match[1]
    if (body !== undefined) results.push(body)
    match = pattern.exec(xml)
  }
  return results
}

const firstTag = (xml: string, tag: string): string | undefined => tagBlocks(xml, tag)[0]

const cleanText = (input: string | undefined): string | undefined => {
  if (input === undefined) return undefined
  const cleaned = decodeEntities(input).replace(/\s+/g, " ").trim()
  return cleaned === "" ? undefined : cleaned
}

const decodeEntities = (input: string): string =>
  input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")

const normalizeArxivId = (input: string): string | undefined => {
  const fromUrl = input.replace(/^https?:\/\/arxiv\.org\/abs\//, "")
  const withoutVersion = fromUrl.replace(/v\d+$/, "")
  return /^\d{4}\.\d{4,5}$/.test(withoutVersion) ? withoutVersion : undefined
}

const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const isAbortError = (cause: unknown): boolean => cause instanceof Error && cause.name === "AbortError"
