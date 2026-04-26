import { Context, Effect, Layer } from "effect"
import type { Input as DurationInput } from "effect/Duration"
import { readFile } from "node:fs/promises"

const AR5IV_URL = "https://ar5iv.labs.arxiv.org/html"
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY: DurationInput = "150 millis"

export type Ar5ivError =
  | { readonly _tag: "Ar5ivHttpError"; readonly status: number; readonly message: string }
  | { readonly _tag: "Ar5ivTransientError"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "Ar5ivTimeoutError"; readonly message: string }
  | { readonly _tag: "Ar5ivDecodeError"; readonly message: string }

export type Ar5ivClientShape = {
  readonly getHtml: (id: string) => Effect.Effect<string, Ar5ivError>
}

export class Ar5ivClient extends Context.Service<Ar5ivClient, Ar5ivClientShape>()("paper7/Ar5ivClient") {}

type FetchInit = {
  readonly signal: AbortSignal
}

type FetchLike = (url: string, init: FetchInit) => Promise<Response>

type Ar5ivClientOptions = {
  readonly baseUrl?: string
  readonly fixturePath?: string
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
  readonly retries?: number
  readonly retryDelay?: DurationInput
}

export const makeAr5ivClient = (options: Ar5ivClientOptions = {}): Ar5ivClientShape => {
  const baseUrl = options.baseUrl ?? AR5IV_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY

  return {
    getHtml: (id) => {
      const fixturePath = options.fixturePath
      const html = fixturePath === undefined
        ? requestHtml({ url: `${baseUrl}/${id}`, fetchImpl, timeoutMs })
        : Effect.tryPromise({
            try: () => readFile(fixturePath, { encoding: "utf8" }),
            catch: (cause): Ar5ivError => ({ _tag: "Ar5ivTransientError", message: "failed to read ar5iv fixture", cause }),
          })

      return retryTransient(html, retries, retryDelay).pipe(Effect.flatMap(decodeHtml))
    },
  }
}

export const Ar5ivLive = Layer.succeed(
  Ar5ivClient,
  makeAr5ivClient({ fixturePath: process.env.PAPER7_AR5IV_FIXTURE })
)

const requestHtml = (input: {
  readonly url: string
  readonly fetchImpl: FetchLike
  readonly timeoutMs: number
}): Effect.Effect<string, Ar5ivError> => {
  const request: Effect.Effect<Response, Ar5ivError> = Effect.tryPromise({
    try: (signal) => fetchWithTimeout(input.fetchImpl, input.url, signal, input.timeoutMs),
    catch: (cause): Ar5ivError => isAbortError(cause)
      ? { _tag: "Ar5ivTimeoutError", message: `ar5iv request timed out after ${input.timeoutMs}ms` }
      : { _tag: "Ar5ivTransientError", message: "ar5iv request failed", cause },
  })

  return request.pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.tryPromise({
          try: () => response.text(),
          catch: (cause): Ar5ivError => ({ _tag: "Ar5ivTransientError", message: "failed to read ar5iv response", cause }),
        })
      }

      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        const error: Ar5ivError = {
          _tag: "Ar5ivTransientError",
          message: `ar5iv transient HTTP ${response.status}`,
          cause: response.status,
        }
        return Effect.fail(error)
      }

      const error: Ar5ivError = { _tag: "Ar5ivHttpError", status: response.status, message: `ar5iv HTTP ${response.status}` }
      return Effect.fail(error)
    })
  )
}

const decodeHtml = (html: string): Effect.Effect<string, Ar5ivError> => {
  if (!/<article(?:\s[^>]*)?>[\s\S]*<\/article>/.test(html)) {
    return Effect.fail({ _tag: "Ar5ivDecodeError", message: "ar5iv response missing article" })
  }
  return Effect.succeed(html)
}

const retryTransient = <A>(
  effect: Effect.Effect<A, Ar5ivError>,
  remaining: number,
  retryDelay: DurationInput
): Effect.Effect<A, Ar5ivError> =>
  effect.pipe(
    Effect.catch((error) => {
      if (error._tag === "Ar5ivTransientError" && remaining > 0) {
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

const isAbortError = (cause: unknown): boolean => cause instanceof Error && cause.name === "AbortError"
