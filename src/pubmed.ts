import { Context, Data, Effect, Layer } from "effect"
import type { Input as DurationInput } from "effect/Duration"
import { readFile } from "node:fs/promises"
import type { SearchSort } from "./parser.js"

const PUBMED_SEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
const PUBMED_SUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
const PUBMED_FETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY: DurationInput = "150 millis"

export type PubmedPaper = {
  readonly id: string
  readonly title: string
  readonly authors: ReadonlyArray<string>
  readonly published: string
}

export type PubmedPaperMetadata = PubmedPaper & {
  readonly journal?: string
  readonly doi?: string
  readonly abstract: string
}

export type PubmedSearchResult = {
  readonly total: number
  readonly papers: ReadonlyArray<PubmedPaper>
  readonly warnings: ReadonlyArray<string>
}

export type PubmedSearchParams = {
  readonly query: string
  readonly max: number
  readonly sort: SearchSort
}

export class PubmedHttpError extends Data.TaggedError("PubmedHttpError")<{
  readonly status: number
  readonly message: string
}> {}

export class PubmedTransientError extends Data.TaggedError("PubmedTransientError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export class PubmedTimeoutError extends Data.TaggedError("PubmedTimeoutError")<{
  readonly message: string
}> {}

export class PubmedDecodeError extends Data.TaggedError("PubmedDecodeError")<{
  readonly message: string
}> {}

export type PubmedError =
  | PubmedHttpError
  | PubmedTransientError
  | PubmedTimeoutError
  | PubmedDecodeError

export type PubmedClientShape = {
  readonly search: (params: PubmedSearchParams) => Effect.Effect<PubmedSearchResult, PubmedError>
  readonly get: (id: string) => Effect.Effect<PubmedPaperMetadata, PubmedError>
}

export class PubmedClient extends Context.Service<PubmedClient, PubmedClientShape>()("paper7/PubmedClient") {}

type FetchInit = {
  readonly signal: AbortSignal
}

type FetchLike = (url: string, init: FetchInit) => Promise<Response>

type PubmedClientOptions = {
  readonly searchUrl?: string
  readonly summaryUrl?: string
  readonly fetchUrl?: string
  readonly searchFixturePath?: string
  readonly summaryFixturePath?: string
  readonly getFixturePath?: string
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
  readonly retries?: number
  readonly retryDelay?: DurationInput
}

type SearchEnvelope = {
  readonly total: number
  readonly ids: ReadonlyArray<string>
}

export const makePubmedClient = (options: PubmedClientOptions = {}): PubmedClientShape => {
  const searchUrl = options.searchUrl ?? PUBMED_SEARCH_URL
  const summaryUrl = options.summaryUrl ?? PUBMED_SUMMARY_URL
  const fetchUrl = options.fetchUrl ?? PUBMED_FETCH_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY

  return {
    search: (params) => {
      const searchJson = loadJson({
        fixturePath: options.searchFixturePath,
        url: buildSearchUrl(searchUrl, params),
        fetchImpl,
        timeoutMs,
        fixtureMessage: "failed to read PubMed search fixture",
        responseMessage: "failed to read PubMed search response",
      })

      return retryTransient(searchJson, retries, retryDelay).pipe(
        Effect.flatMap(decodeSearchResponse),
        Effect.flatMap((search) => {
          if (search.ids.length === 0) return Effect.succeed({ total: search.total, papers: [], warnings: [] })
          const summaryJson = loadJson({
            fixturePath: options.summaryFixturePath,
            url: buildSummaryUrl(summaryUrl, search.ids),
            fetchImpl,
            timeoutMs,
            fixtureMessage: "failed to read PubMed summary fixture",
            responseMessage: "failed to read PubMed summary response",
          })
          return retryTransient(summaryJson, retries, retryDelay).pipe(
            Effect.flatMap((json) => decodeSummaryResponse(search, json))
          )
        })
      )
    },
    get: (id) => {
      const xml = loadJson({
        fixturePath: options.getFixturePath,
        url: buildFetchUrl(fetchUrl, id),
        fetchImpl,
        timeoutMs,
        fixtureMessage: "failed to read PubMed get fixture",
        responseMessage: "failed to read PubMed get response",
      })

      return retryTransient(xml, retries, retryDelay).pipe(Effect.flatMap((body) => decodeGetResponse(id, body)))
    },
  }
}

export const PubmedLive = Layer.succeed(
  PubmedClient,
  makePubmedClient({
    searchFixturePath: process.env.PAPER7_PUBMED_SEARCH_FIXTURE,
    summaryFixturePath: process.env.PAPER7_PUBMED_SUMMARY_FIXTURE,
    getFixturePath: process.env.PAPER7_PUBMED_GET_FIXTURE,
  })
)

export const decodeGetResponse = (id: string, xml: string): Effect.Effect<PubmedPaperMetadata, PubmedError> => {
  const article = firstBlock(xml, "PubmedArticle")
  if (article === undefined) {
    return Effect.fail(new PubmedDecodeError({ message: `PubMed response missing paper ${id}` }))
  }

  const title = cleanText(stripTags(firstTag(article, "ArticleTitle")))
  const authors = authorsFromXml(article)
  const published = dateFromXml(article)
  const abstract = abstractFromXml(article)
  if (title === undefined || authors.length === 0 || published === undefined || abstract === undefined) {
    return Effect.fail(new PubmedDecodeError({ message: `PubMed response has invalid paper ${id}` }))
  }

  const journal = cleanText(stripTags(firstBlock(firstBlock(article, "Journal") ?? "", "Title") ?? firstTag(article, "ISOAbbreviation")))
  const doi = cleanText(stripTags(firstArticleId(article, "doi") ?? firstELocationId(article, "doi")))
  return Effect.succeed({ id: `pmid:${id}`, title, authors, published, journal, doi, abstract })
}

export const decodeSearchResponse = (json: string): Effect.Effect<SearchEnvelope, PubmedError> => {
  const parsed = parseJson(json)
  if (parsed._tag === "error") return Effect.fail(parsed.error)

  const root = getRecord(parsed.value)
  const result = root === undefined ? undefined : getRecord(root.esearchresult)
  const countText = result === undefined ? undefined : getString(result.count)
  const idlist = result === undefined ? undefined : getStringArray(result.idlist)
  if (countText === undefined || idlist === undefined) {
    return Effect.fail(new PubmedDecodeError({ message: "PubMed search response missing count or idlist" }))
  }

  const total = Number(countText)
  if (!Number.isSafeInteger(total) || total < 0) {
    return Effect.fail(new PubmedDecodeError({ message: "PubMed search response has invalid count" }))
  }

  return Effect.succeed({ total, ids: idlist })
}

export const decodeSummaryResponse = (
  search: SearchEnvelope,
  json: string
): Effect.Effect<PubmedSearchResult, PubmedError> => {
  const parsed = parseJson(json)
  if (parsed._tag === "error") return Effect.fail(parsed.error)

  const root = getRecord(parsed.value)
  const result = root === undefined ? undefined : getRecord(root.result)
  if (result === undefined) {
    return Effect.fail(new PubmedDecodeError({ message: "PubMed summary response missing result" }))
  }

  const papers: Array<PubmedPaper> = []
  const warnings: Array<string> = []
  for (const id of search.ids) {
    const paper = decodePaper(id, result[id])
    if (paper._tag === "paper") {
      papers.push(paper.paper)
    } else {
      warnings.push(paper.message)
    }
  }

  return Effect.succeed({ total: search.total, papers, warnings })
}

const loadJson = (input: {
  readonly fixturePath: string | undefined
  readonly url: string
  readonly fetchImpl: FetchLike
  readonly timeoutMs: number
  readonly fixtureMessage: string
  readonly responseMessage: string
}): Effect.Effect<string, PubmedError> => {
  const fixturePath = input.fixturePath
  if (fixturePath !== undefined) {
    return Effect.tryPromise({
      try: () => readFile(fixturePath, { encoding: "utf8" }),
      catch: (cause): PubmedError => new PubmedTransientError({ message: input.fixtureMessage, cause }),
    })
  }

  const request: Effect.Effect<Response, PubmedError> = Effect.tryPromise({
    try: (signal) => fetchWithTimeout(input.fetchImpl, input.url, signal, input.timeoutMs),
    catch: (cause): PubmedError => isAbortError(cause)
      ? new PubmedTimeoutError({ message: `PubMed request timed out after ${input.timeoutMs}ms` })
      : new PubmedTransientError({ message: "PubMed request failed", cause }),
  })

  return request.pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.tryPromise({
          try: () => response.text(),
          catch: (cause): PubmedError => new PubmedTransientError({ message: input.responseMessage, cause }),
        })
      }

      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        const error: PubmedError = new PubmedTransientError({
          message: `PubMed transient HTTP ${response.status}`,
          cause: response.status,
        })
        return Effect.fail(error)
      }

      const error: PubmedError = new PubmedHttpError({
        status: response.status,
        message: `PubMed HTTP ${response.status}`,
      })
      return Effect.fail(error)
    })
  )
}

const retryTransient = <A>(
  effect: Effect.Effect<A, PubmedError>,
  remaining: number,
  retryDelay: DurationInput
): Effect.Effect<A, PubmedError> =>
  effect.pipe(
    Effect.catch((error) => {
      if (error._tag === "PubmedTransientError" && remaining > 0) {
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

const buildSearchUrl = (apiUrl: string, params: PubmedSearchParams): string => {
  const url = new URL(apiUrl)
  url.searchParams.set("db", "pubmed")
  url.searchParams.set("retmode", "json")
  url.searchParams.set("term", params.query)
  url.searchParams.set("retmax", String(params.max))
  url.searchParams.set("sort", params.sort === "date" ? "pub date" : "relevance")
  return url.toString()
}

const buildSummaryUrl = (apiUrl: string, ids: ReadonlyArray<string>): string => {
  const url = new URL(apiUrl)
  url.searchParams.set("db", "pubmed")
  url.searchParams.set("retmode", "json")
  url.searchParams.set("id", ids.join(","))
  return url.toString()
}

const buildFetchUrl = (apiUrl: string, id: string): string => {
  const url = new URL(apiUrl)
  url.searchParams.set("db", "pubmed")
  url.searchParams.set("rettype", "abstract")
  url.searchParams.set("retmode", "xml")
  url.searchParams.set("id", id)
  url.searchParams.set("tool", "paper7")
  return url.toString()
}

const decodePaper = (id: string, value: unknown):
  | { readonly _tag: "paper"; readonly paper: PubmedPaper }
  | { readonly _tag: "warning"; readonly message: string } => {
  const record = getRecord(value)
  const title = record === undefined ? undefined : cleanText(getString(record.title))
  const published = record === undefined ? undefined : normalizeDate(getString(record.pubdate))
  const authors = record === undefined ? undefined : getAuthors(record.authors)

  if (title === undefined || published === undefined || authors === undefined) {
    return { _tag: "warning", message: "PubMed partial failure: skipped malformed result" }
  }

  return { _tag: "paper", paper: { id: `pmid:${id}`, title, authors, published } }
}

const parseJson = (json: string):
  | { readonly _tag: "ok"; readonly value: unknown }
  | { readonly _tag: "error"; readonly error: PubmedError } => {
  try {
    const value: unknown = JSON.parse(json)
    return { _tag: "ok", value }
  } catch {
    return { _tag: "error", error: new PubmedDecodeError({ message: "PubMed response is not valid JSON" }) }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const getRecord = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined

const getString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const getStringArray = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined
  const strings: Array<string> = []
  for (const item of value) {
    if (typeof item !== "string") return undefined
    strings.push(item)
  }
  return strings
}

const getAuthors = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined
  const authors: Array<string> = []
  for (const item of value) {
    const record = getRecord(item)
    const name = record === undefined ? undefined : cleanText(getString(record.name))
    if (name !== undefined) authors.push(name)
  }
  return authors
}

const cleanText = (input: string | undefined): string | undefined => {
  if (input === undefined) return undefined
  const cleaned = input.replace(/\s+/g, " ").trim()
  return cleaned === "" ? undefined : cleaned
}

const normalizeDate = (input: string | undefined): string | undefined => {
  const text = cleanText(input)
  if (text === undefined) return undefined
  const year = /^\d{4}/.exec(text)
  return year === null ? text : year[0]
}

const firstBlock = (xml: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)
  return match?.[1]
}

const firstTag = (xml: string, tag: string): string | undefined => firstBlock(xml, tag)

const tagBlocks = (xml: string, tag: string): ReadonlyArray<string> => {
  const matches: Array<string> = []
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g")
  let match = pattern.exec(xml)
  while (match !== null) {
    const block = match[1]
    if (block !== undefined) matches.push(block)
    match = pattern.exec(xml)
  }
  return matches
}

const authorsFromXml = (xml: string): ReadonlyArray<string> => {
  const authors: Array<string> = []
  for (const author of tagBlocks(xml, "Author")) {
    const last = cleanText(stripTags(firstTag(author, "LastName")))
    const initials = cleanText(stripTags(firstTag(author, "Initials")))
    const collective = cleanText(stripTags(firstTag(author, "CollectiveName")))
    if (last !== undefined) authors.push(initials === undefined ? last : `${last} ${initials}`)
    else if (collective !== undefined) authors.push(collective)
  }
  return authors
}

const dateFromXml = (xml: string): string | undefined => {
  const pubDate = firstBlock(xml, "PubDate")
  if (pubDate === undefined) return undefined
  const year = cleanText(stripTags(firstTag(pubDate, "Year")))
  const month = cleanText(stripTags(firstTag(pubDate, "Month")))
  const day = cleanText(stripTags(firstTag(pubDate, "Day")))
  const medline = cleanText(stripTags(firstTag(pubDate, "MedlineDate")))
  if (year === undefined) return medline
  return [year, month, day].filter((part) => part !== undefined).join(" ")
}

const abstractFromXml = (xml: string): string | undefined => {
  const parts: Array<string> = []
  const pattern = /<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g
  let match = pattern.exec(xml)
  while (match !== null) {
    const attrs = match[1] ?? ""
    const text = cleanText(decodeEntities(stripTags(match[2])))
    const label = labelFromAttrs(attrs)
    if (text !== undefined) parts.push(label === undefined ? text : `**${label}.** ${text}`)
    match = pattern.exec(xml)
  }
  return parts.length === 0 ? undefined : parts.join("\n\n")
}

const labelFromAttrs = (attrs: string): string | undefined => {
  const match = /\sLabel="([^"]+)"/.exec(attrs)
  return cleanText(decodeEntities(match?.[1]))
}

const firstArticleId = (xml: string, idType: string): string | undefined => {
  const pattern = new RegExp(`<ArticleId[^>]*IdType="${idType}"[^>]*>([\\s\\S]*?)</ArticleId>`)
  return pattern.exec(xml)?.[1]
}

const firstELocationId = (xml: string, idType: string): string | undefined => {
  const pattern = new RegExp(`<ELocationID[^>]*EIdType="${idType}"[^>]*>([\\s\\S]*?)</ELocationID>`)
  return pattern.exec(xml)?.[1]
}

const stripTags = (input: string | undefined): string | undefined => input?.replace(/<[^>]*>/g, "")

const decodeEntities = (input: string | undefined): string | undefined => input
  ?.replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, " ")

const isAbortError = (cause: unknown): boolean => cause instanceof Error && cause.name === "AbortError"
