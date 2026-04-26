import { Context, Effect, Layer } from "effect"
import type { Input as DurationInput } from "effect/Duration"
import { readFile } from "node:fs/promises"
import type { PaperIdentifier } from "./parser.js"

const PWC_API_URL = "https://paperswithcode.com/api/v1"
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY: DurationInput = "150 millis"

export type RepositoryCandidate = {
  readonly url: string
  readonly source: "papers-with-code"
  readonly name?: string
  readonly isOfficial?: boolean
}

export type RepositoryDiscoveryResult = {
  readonly candidates: ReadonlyArray<RepositoryCandidate>
  readonly warnings: ReadonlyArray<string>
}

export type RepositoryDiscoveryError =
  | { readonly _tag: "PapersWithCodeHttpError"; readonly status: number; readonly message: string }
  | { readonly _tag: "PapersWithCodeTransientError"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "PapersWithCodeTimeoutError"; readonly message: string }
  | { readonly _tag: "PapersWithCodeDecodeError"; readonly message: string }

export type RepositoryDiscoveryClientShape = {
  readonly discover: (id: PaperIdentifier) => Effect.Effect<RepositoryDiscoveryResult, RepositoryDiscoveryError>
}

export class RepositoryDiscoveryClient extends Context.Service<RepositoryDiscoveryClient, RepositoryDiscoveryClientShape>()("paper7/RepositoryDiscoveryClient") {}

type FetchInit = {
  readonly signal: AbortSignal
}

type FetchLike = (url: string, init: FetchInit) => Promise<Response>

type RepositoryDiscoveryClientOptions = {
  readonly apiUrl?: string
  readonly papersFixturePath?: string
  readonly repositoriesFixturePath?: string
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
  readonly retries?: number
  readonly retryDelay?: DurationInput
}

type PaperSearchResult = {
  readonly paperId?: string
}

export const makeRepositoryDiscoveryClient = (options: RepositoryDiscoveryClientOptions = {}): RepositoryDiscoveryClientShape => {
  const apiUrl = options.apiUrl ?? PWC_API_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY

  return {
    discover: (id) => {
      const papersJson = loadJson({
        fixturePath: options.papersFixturePath,
        url: buildPapersUrl(apiUrl, id),
        fetchImpl,
        timeoutMs,
        fixtureMessage: "failed to read Papers With Code papers fixture",
        responseMessage: "failed to read Papers With Code papers response",
      })

      return retryTransient(papersJson, retries, retryDelay).pipe(
        Effect.flatMap(decodePaperSearch),
        Effect.flatMap((paper) => {
          if (paper.paperId === undefined) return Effect.succeed({ candidates: [], warnings: [] })
          const repositoriesJson = loadJson({
            fixturePath: options.repositoriesFixturePath,
            url: buildRepositoriesUrl(apiUrl, paper.paperId),
            fetchImpl,
            timeoutMs,
            fixtureMessage: "failed to read Papers With Code repositories fixture",
            responseMessage: "failed to read Papers With Code repositories response",
          })
          return retryTransient(repositoriesJson, retries, retryDelay).pipe(Effect.flatMap(decodeRepositories))
        })
      )
    },
  }
}

export const RepositoryDiscoveryLive = Layer.succeed(
  RepositoryDiscoveryClient,
  makeRepositoryDiscoveryClient({
    papersFixturePath: process.env.PAPER7_PWC_PAPERS_FIXTURE,
    repositoriesFixturePath: process.env.PAPER7_PWC_REPOS_FIXTURE,
  })
)

export const decodePaperSearch = (json: string): Effect.Effect<PaperSearchResult, RepositoryDiscoveryError> => {
  const parsed = parseJson(json)
  if (parsed._tag === "error") return Effect.fail(parsed.error)

  const root = getRecord(parsed.value)
  const results = root === undefined ? undefined : getArray(root.results)
  if (results === undefined) {
    return Effect.fail({ _tag: "PapersWithCodeDecodeError", message: "Papers With Code paper response missing results" })
  }

  for (const item of results) {
    const paper = getRecord(item)
    const paperId = paper === undefined ? undefined : cleanText(getString(paper.id))
    if (paperId !== undefined) return Effect.succeed({ paperId })
  }

  return Effect.succeed({})
}

export const decodeRepositories = (json: string): Effect.Effect<RepositoryDiscoveryResult, RepositoryDiscoveryError> => {
  const parsed = parseJson(json)
  if (parsed._tag === "error") return Effect.fail(parsed.error)

  const root = getRecord(parsed.value)
  const results = root === undefined ? undefined : getArray(root.results)
  if (results === undefined) {
    return Effect.fail({ _tag: "PapersWithCodeDecodeError", message: "Papers With Code repository response missing results" })
  }

  const candidates: Array<RepositoryCandidate> = []
  const warnings: Array<string> = []
  for (const item of results) {
    const decoded = decodeRepository(item)
    if (decoded._tag === "repository") candidates.push(decoded.repository)
    else warnings.push(decoded.message)
  }

  return Effect.succeed({ candidates, warnings })
}

const loadJson = (input: {
  readonly fixturePath: string | undefined
  readonly url: string
  readonly fetchImpl: FetchLike
  readonly timeoutMs: number
  readonly fixtureMessage: string
  readonly responseMessage: string
}): Effect.Effect<string, RepositoryDiscoveryError> => {
  const fixturePath = input.fixturePath
  if (fixturePath !== undefined) {
    return Effect.tryPromise({
      try: () => readFile(fixturePath, { encoding: "utf8" }),
      catch: (cause): RepositoryDiscoveryError => ({ _tag: "PapersWithCodeTransientError", message: input.fixtureMessage, cause }),
    })
  }

  const request: Effect.Effect<Response, RepositoryDiscoveryError> = Effect.tryPromise({
    try: (signal) => fetchWithTimeout(input.fetchImpl, input.url, signal, input.timeoutMs),
    catch: (cause): RepositoryDiscoveryError => isAbortError(cause)
      ? { _tag: "PapersWithCodeTimeoutError", message: `Papers With Code request timed out after ${input.timeoutMs}ms` }
      : { _tag: "PapersWithCodeTransientError", message: "Papers With Code request failed", cause },
  })

  return request.pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.tryPromise({
          try: () => response.text(),
          catch: (cause): RepositoryDiscoveryError => ({ _tag: "PapersWithCodeTransientError", message: input.responseMessage, cause }),
        })
      }

      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        const error: RepositoryDiscoveryError = {
          _tag: "PapersWithCodeTransientError",
          message: `Papers With Code transient HTTP ${response.status}`,
          cause: response.status,
        }
        return Effect.fail(error)
      }

      const error: RepositoryDiscoveryError = {
        _tag: "PapersWithCodeHttpError",
        status: response.status,
        message: `Papers With Code HTTP ${response.status}`,
      }
      return Effect.fail(error)
    })
  )
}

const retryTransient = <A>(
  effect: Effect.Effect<A, RepositoryDiscoveryError>,
  remaining: number,
  retryDelay: DurationInput
): Effect.Effect<A, RepositoryDiscoveryError> =>
  effect.pipe(
    Effect.catch((error) => {
      if (error._tag === "PapersWithCodeTransientError" && remaining > 0) {
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

const buildPapersUrl = (apiUrl: string, id: PaperIdentifier): string => {
  const url = new URL(`${apiUrl.replace(/\/$/, "")}/papers/`)
  switch (id.tag) {
    case "arxiv":
      url.searchParams.set("arxiv_id", id.id)
      break
    case "pubmed":
      url.searchParams.set("pmid", id.id)
      break
    case "doi":
      url.searchParams.set("doi", id.id)
      break
  }
  return url.toString()
}

const buildRepositoriesUrl = (apiUrl: string, paperId: string): string =>
  `${apiUrl.replace(/\/$/, "")}/papers/${encodeURIComponent(paperId)}/repositories/`

const decodeRepository = (value: unknown):
  | { readonly _tag: "repository"; readonly repository: RepositoryCandidate }
  | { readonly _tag: "warning"; readonly message: string } => {
  const item = getRecord(value)
  if (item === undefined) return { _tag: "warning", message: "Papers With Code partial failure: skipped malformed repository" }

  const url = cleanText(getString(item.url))
  if (url === undefined) return { _tag: "warning", message: "Papers With Code partial failure: skipped malformed repository" }

  const name = cleanText(getString(item.name))
  const isOfficial = getBoolean(item.is_official)
  if (name === undefined && isOfficial === undefined) return { _tag: "repository", repository: { url, source: "papers-with-code" } }
  if (name === undefined) return { _tag: "repository", repository: { url, source: "papers-with-code", isOfficial } }
  if (isOfficial === undefined) return { _tag: "repository", repository: { url, source: "papers-with-code", name } }
  return { _tag: "repository", repository: { url, source: "papers-with-code", name, isOfficial } }
}

const parseJson = (json: string):
  | { readonly _tag: "ok"; readonly value: unknown }
  | { readonly _tag: "error"; readonly error: RepositoryDiscoveryError } => {
  try {
    return { _tag: "ok", value: JSON.parse(json) }
  } catch {
    return { _tag: "error", error: { _tag: "PapersWithCodeDecodeError", message: "Papers With Code response is not valid JSON" } }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const getRecord = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined

const getArray = (value: unknown): ReadonlyArray<unknown> | undefined => Array.isArray(value) ? value : undefined

const getString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const getBoolean = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined

const cleanText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const cleaned = value.trim()
  return cleaned === "" ? undefined : cleaned
}

const isAbortError = (cause: unknown): boolean =>
  cause instanceof DOMException && cause.name === "AbortError"
