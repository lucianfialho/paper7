import { Context, Data, Effect, Layer } from "effect"
import type { Input as DurationInput } from "effect/Duration"
import { readFile } from "node:fs/promises"

const CROSSREF_URL = "https://api.crossref.org/works"
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY: DurationInput = "150 millis"

export const CROSSREF_POLITE_POOL_EMAIL = "edu.santos.brito@gmail.com"

export type CrossrefPaperMetadata = {
  readonly id: string
  readonly title: string
  readonly authors: ReadonlyArray<string>
  readonly source: string
  readonly published: string
  readonly doi: string
  readonly fullTextUrl: string
  readonly abstract: string
}

export class CrossrefHttpError extends Data.TaggedError("CrossrefHttpError")<{
  readonly status: number
  readonly message: string
}> {}

export class CrossrefTransientError extends Data.TaggedError("CrossrefTransientError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export class CrossrefTimeoutError extends Data.TaggedError("CrossrefTimeoutError")<{
  readonly message: string
}> {}

export class CrossrefDecodeError extends Data.TaggedError("CrossrefDecodeError")<{
  readonly message: string
}> {}

export type CrossrefError =
  | CrossrefHttpError
  | CrossrefTransientError
  | CrossrefTimeoutError
  | CrossrefDecodeError

export type CrossrefClientShape = {
  readonly get: (doi: string) => Effect.Effect<CrossrefPaperMetadata, CrossrefError>
}

export class CrossrefClient extends Context.Service<CrossrefClient, CrossrefClientShape>()("paper7/CrossrefClient") {}

type FetchInit = {
  readonly signal: AbortSignal
}

type FetchLike = (url: string, init: FetchInit) => Promise<Response>

type CrossrefClientOptions = {
  readonly apiUrl?: string
  readonly fixturePath?: string
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
  readonly retries?: number
  readonly retryDelay?: DurationInput
}

export const makeCrossrefClient = (options: CrossrefClientOptions = {}): CrossrefClientShape => {
  const apiUrl = options.apiUrl ?? CROSSREF_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY

  return {
    get: (doi) => {
      const fixturePath = options.fixturePath
      const json: Effect.Effect<string, CrossrefError> = fixturePath === undefined
        ? requestJson({ url: buildWorkUrl(apiUrl, doi), fetchImpl, timeoutMs })
        : Effect.tryPromise({
            try: () => readFile(fixturePath, { encoding: "utf8" }),
            catch: (cause): CrossrefError => new CrossrefTransientError({ message: "failed to read Crossref fixture", cause }),
          })

      return retryTransient(json, retries, retryDelay).pipe(Effect.flatMap((body) => decodeCrossrefWork(doi, body)))
    },
  }
}

export const CrossrefLive = Layer.succeed(
  CrossrefClient,
  makeCrossrefClient({ fixturePath: process.env.PAPER7_CROSSREF_FIXTURE })
)

export const decodeCrossrefWork = (doi: string, json: string): Effect.Effect<CrossrefPaperMetadata, CrossrefError> => {
  const parsed = parseJson(json)
  if (parsed._tag === "error") return Effect.fail(parsed.error)

  const root = getRecord(parsed.value)
  const message = root === undefined ? undefined : getRecord(root.message)
  if (message === undefined) {
    return Effect.fail(new CrossrefDecodeError({ message: "Crossref response missing message" }))
  }

  const canonicalDoi = cleanText(getString(message.DOI)) ?? doi
  const title = cleanText(firstString(message.title))
  const authors = authorsFromMessage(message.author)
  const source = cleanText(firstString(message.institution, "name")) ?? cleanText(getString(message.publisher)) ?? "Unknown source"
  const published = dateFromParts(message.issued) ?? dateFromParts(message.created) ?? "Unknown"
  const fullTextUrl = fullTextFromMessage(message, canonicalDoi)
  const abstract = cleanAbstract(getString(message.abstract)) ?? `(no abstract available; full text at ${fullTextUrl})`

  if (title === undefined || authors.length === 0 || fullTextUrl === undefined) {
    return Effect.fail(new CrossrefDecodeError({ message: `Crossref response has invalid paper ${doi}` }))
  }

  return Effect.succeed({
    id: `doi:${canonicalDoi}`,
    title,
    authors,
    source,
    published,
    doi: canonicalDoi,
    fullTextUrl,
    abstract,
  })
}

const requestJson = (input: {
  readonly url: string
  readonly fetchImpl: FetchLike
  readonly timeoutMs: number
}): Effect.Effect<string, CrossrefError> => {
  const request: Effect.Effect<Response, CrossrefError> = Effect.tryPromise({
    try: (signal) => fetchWithTimeout(input.fetchImpl, input.url, signal, input.timeoutMs),
    catch: (cause): CrossrefError => isAbortError(cause)
      ? new CrossrefTimeoutError({ message: `Crossref request timed out after ${input.timeoutMs}ms` })
      : new CrossrefTransientError({ message: "Crossref request failed", cause }),
  })

  return request.pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.tryPromise({
          try: () => response.text(),
          catch: (cause): CrossrefError => new CrossrefTransientError({ message: "failed to read Crossref response", cause }),
        })
      }

      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return Effect.fail(new CrossrefTransientError({ message: `Crossref transient HTTP ${response.status}`, cause: response.status }))
      }

      return Effect.fail(new CrossrefHttpError({ status: response.status, message: `Crossref HTTP ${response.status}` }))
    })
  )
}

const retryTransient = <A>(
  effect: Effect.Effect<A, CrossrefError>,
  remaining: number,
  retryDelay: DurationInput
): Effect.Effect<A, CrossrefError> =>
  effect.pipe(
    Effect.catch((error) => {
      if (error._tag === "CrossrefTransientError" && remaining > 0) {
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

const buildWorkUrl = (apiUrl: string, doi: string): string => {
  const url = new URL(`${apiUrl.replace(/\/$/, "")}/${encodeURIComponent(doi)}`)
  url.searchParams.set("mailto", CROSSREF_POLITE_POOL_EMAIL)
  return url.toString()
}

const parseJson = (json: string):
  | { readonly _tag: "ok"; readonly value: unknown }
  | { readonly _tag: "error"; readonly error: CrossrefError } => {
  try {
    return { _tag: "ok", value: JSON.parse(json) }
  } catch {
    return { _tag: "error", error: new CrossrefDecodeError({ message: "Crossref response is not valid JSON" }) }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const getRecord = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined

const getString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const firstString = (value: unknown, key?: string): string | undefined => {
  if (!Array.isArray(value)) return undefined
  const first = value[0]
  if (key === undefined) return getString(first)
  const record = getRecord(first)
  return record === undefined ? undefined : getString(record[key])
}

const authorsFromMessage = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return []
  const authors: Array<string> = []
  for (const item of value) {
    const record = getRecord(item)
    if (record === undefined) continue
    const given = cleanText(getString(record.given))
    const family = cleanText(getString(record.family))
    const name = cleanText([given, family].filter((part) => part !== undefined).join(" "))
    if (name !== undefined) authors.push(name)
  }
  return authors
}

const dateFromParts = (value: unknown): string | undefined => {
  const record = getRecord(value)
  const parts = record === undefined ? undefined : record["date-parts"]
  if (!Array.isArray(parts)) return undefined
  const first = parts[0]
  if (!Array.isArray(first)) return undefined
  const numbers: Array<number> = []
  for (const part of first) {
    if (typeof part !== "number" || !Number.isSafeInteger(part)) return undefined
    numbers.push(part)
  }
  if (numbers.length === 0) return undefined
  const year = numbers[0]
  if (year === undefined) return undefined
  const month = numbers[1]
  const day = numbers[2]
  if (month === undefined) return String(year)
  if (day === undefined) return `${year}-${pad2(month)}`
  return `${year}-${pad2(month)}-${pad2(day)}`
}

const fullTextFromMessage = (message: Record<string, unknown>, doi: string): string | undefined => {
  const direct = cleanText(getString(message.URL))
  if (direct !== undefined) return direct
  const resource = getRecord(message.resource)
  const primary = resource === undefined ? undefined : getRecord(resource.primary)
  return cleanText(primary === undefined ? undefined : getString(primary.URL)) ?? `https://doi.org/${doi}`
}

const cleanAbstract = (input: string | undefined): string | undefined => cleanText(decodeEntities(stripTags(
  input
    ?.replace(/<jats:title>[\s\S]*?<\/jats:title>/g, "")
    .replace(/<jats:p>/g, "\n\n")
    .replace(/<\/jats:p>/g, "")
)))

const stripTags = (input: string | undefined): string | undefined => input?.replace(/<[^>]*>/g, "")

const decodeEntities = (input: string | undefined): string | undefined => input
  ?.replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, " ")

const cleanText = (input: string | undefined): string | undefined => {
  if (input === undefined) return undefined
  const cleaned = input.replace(/\s+/g, " ").trim()
  return cleaned === "" ? undefined : cleaned
}

const pad2 = (value: number): string => String(value).padStart(2, "0")

const isAbortError = (cause: unknown): boolean => cause instanceof Error && cause.name === "AbortError"
