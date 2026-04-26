import { Effect } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Ar5ivClient, type Ar5ivError } from "./ar5iv.js"
import { ArxivClient, type ArxivError, type ArxivPaperMetadata } from "./arxiv.js"
import { CrossrefClient, type CrossrefError, type CrossrefPaperMetadata } from "./crossref.js"
import type { RangeSpec } from "./parser.js"
import { PubmedClient, type PubmedError, type PubmedPaperMetadata } from "./pubmed.js"

export type GetError =
  | { readonly _tag: "GetCacheReadError"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "GetCacheWriteError"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "GetRangeError"; readonly message: string }
  | { readonly _tag: "GetArxivError"; readonly error: ArxivError }
  | { readonly _tag: "GetAr5ivError"; readonly error: Ar5ivError }
  | { readonly _tag: "GetPubmedError"; readonly error: PubmedError }
  | { readonly _tag: "GetCrossrefError"; readonly error: CrossrefError }

export type GetArxivParams = {
  readonly id: string
  readonly cache: boolean
  readonly refs: boolean
  readonly tldr: boolean
  readonly detailed: boolean
  readonly range?: RangeSpec
}

export type GetPubmedParams = Omit<GetArxivParams, "id"> & {
  readonly id: string
}

export type GetDoiParams = Omit<GetArxivParams, "id"> & {
  readonly id: string
}

export const getArxivPaper = (params: GetArxivParams): Effect.Effect<string, GetError, ArxivClient | Ar5ivClient> => {
  const dir = cacheDir(params.id)
  const cacheFile = join(dir, "paper.md")

  const fetchPaper = params.tldr ? fetchAndCache : fetchAndCacheWithoutTldr
  const paper = params.cache
    ? readCachedPaper(cacheFile).pipe(
        Effect.catch(() => fetchPaper(params.id, dir, cacheFile))
      )
    : fetchPaper(params.id, dir, cacheFile)

  return paper.pipe(
    Effect.flatMap((markdown) => renderMarkdown(markdown, params)),
    Effect.map((markdown) => wrapUntrusted(markdown, "arxiv", params.id))
  )
}

export const getPubmedPaper = (params: GetPubmedParams): Effect.Effect<string, GetError, PubmedClient> => {
  const cacheId = `pmid-${params.id}`
  const paperId = `pmid:${params.id}`
  const dir = cacheDir(cacheId)
  const cacheFile = join(dir, "paper.md")
  const paper = params.cache
    ? readCachedPaper(cacheFile).pipe(Effect.catch(() => fetchAndCachePubmed(params.id, dir, cacheFile, params.tldr)))
    : fetchAndCachePubmed(params.id, dir, cacheFile, params.tldr)

  return paper.pipe(
    Effect.flatMap((markdown) => renderMarkdown(markdown, { ...params, id: paperId })),
    Effect.map((markdown) => wrapUntrusted(markdown, "pubmed", paperId))
  )
}

export const getDoiPaper = (params: GetDoiParams): Effect.Effect<string, GetError, CrossrefClient | ArxivClient | Ar5ivClient> => {
  const arxivId = arxivIdFromDoi(params.id)
  if (arxivId !== undefined) return getArxivPaper({ ...params, id: arxivId })

  const paperId = `doi:${params.id}`
  const dir = cacheDir(`doi-${safeDoiDir(params.id)}`)
  const cacheFile = join(dir, "paper.md")
  const paper = params.cache
    ? readCachedPaper(cacheFile).pipe(Effect.catch(() => fetchAndCacheDoi(params.id, dir, cacheFile, params.tldr)))
    : fetchAndCacheDoi(params.id, dir, cacheFile, params.tldr)

  return paper.pipe(
    Effect.flatMap((markdown) => renderMarkdown(markdown, { ...params, id: paperId })),
    Effect.map((markdown) => wrapUntrusted(markdown, "doi", paperId))
  )
}

const fetchAndCache = (
  id: string,
  dir: string,
  cacheFile: string
): Effect.Effect<string, GetError, ArxivClient | Ar5ivClient> =>
  ArxivClient.use((arxiv) => arxiv.get(id)).pipe(
    Effect.mapError((error): GetError => ({ _tag: "GetArxivError", error })),
    Effect.zipWith(
      Effect.zipWith(
        Ar5ivClient.use((ar5iv) => ar5iv.getHtml(id)).pipe(
          Effect.mapError((error): GetError => ({ _tag: "GetAr5ivError", error }))
        ),
        fetchTldr(id),
        (html, tldr) => ({ html, tldr })
      ),
      (metadata, fetched) => buildCanonicalMarkdown(metadata, fetched.html, fetched.tldr)
    ),
    Effect.flatMap((markdown) => writeCachedPaper(dir, cacheFile, markdown).pipe(Effect.as(markdown)))
  )

const fetchAndCacheWithoutTldr = (
  id: string,
  dir: string,
  cacheFile: string
): Effect.Effect<string, GetError, ArxivClient | Ar5ivClient> =>
  ArxivClient.use((arxiv) => arxiv.get(id)).pipe(
    Effect.mapError((error): GetError => ({ _tag: "GetArxivError", error })),
    Effect.zipWith(
      Ar5ivClient.use((ar5iv) => ar5iv.getHtml(id)).pipe(
        Effect.mapError((error): GetError => ({ _tag: "GetAr5ivError", error }))
      ),
      (metadata, html) => buildCanonicalMarkdown(metadata, html, undefined)
    ),
    Effect.flatMap((markdown) => writeCachedPaper(dir, cacheFile, markdown).pipe(Effect.as(markdown)))
  )

const fetchTldr = (id: string): Effect.Effect<string | undefined> => {
  const fixturePath = process.env.PAPER7_S2_FIXTURE
  const source: Effect.Effect<string, unknown> = fixturePath === undefined
    ? requestTldrJson(id)
    : Effect.tryPromise({
        try: () => readFile(fixturePath, { encoding: "utf8" }),
        catch: (cause) => cause,
      })

  return source.pipe(
    Effect.flatMap(decodeTldr),
    Effect.catch(() => Effect.succeed(undefined))
  )
}

const requestTldrJson = (id: string): Effect.Effect<string, unknown> => {
  const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2PaperId(id))}`)
  url.searchParams.set("fields", "tldr")
  url.searchParams.set("tool", "paper7")

  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`Semantic Scholar HTTP ${response.status}`)
      return response.text()
    },
    catch: (cause) => cause,
  })
}

const s2PaperId = (id: string): string => id.includes(":") ? id : `arXiv:${id}`

const decodeTldr = (json: string): Effect.Effect<string | undefined, unknown> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(json)
      if (!isRecord(parsed)) return undefined
      const tldr = parsed.tldr
      if (!isRecord(tldr)) return undefined
      const text = tldr.text
      if (typeof text !== "string") return undefined
      const normalized = normalizeSummary(text)
      return normalized === "" ? undefined : normalized
    },
    catch: (cause) => cause,
  })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const readCachedPaper = (cacheFile: string): Effect.Effect<string, GetError> =>
  Effect.tryPromise({
    try: () => readFile(cacheFile, { encoding: "utf8" }),
    catch: (cause): GetError => ({ _tag: "GetCacheReadError", message: "cache miss", cause }),
  })

const writeCachedPaper = (dir: string, cacheFile: string, markdown: string): Effect.Effect<void, GetError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(cacheFile, markdown, { encoding: "utf8" })
    },
    catch: (cause): GetError => ({ _tag: "GetCacheWriteError", message: "failed to write cache", cause }),
  })

const cacheDir = (id: string): string => join(process.env.HOME ?? ".", ".paper7", "cache", id)

const writeMeta = (dir: string, id: string, title: string, authors: ReadonlyArray<string>, url: string): Effect.Effect<void, GetError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "meta.json"), JSON.stringify({ id, title, authors: authors.join(", "), url }), { encoding: "utf8" })
    },
    catch: (cause): GetError => ({ _tag: "GetCacheWriteError", message: "failed to write cache", cause }),
  })

const buildCanonicalMarkdown = (metadata: ArxivPaperMetadata, html: string, tldr: string | undefined): string => {
  const body = htmlToMarkdown(html)
  return [
    `# ${metadata.title}`,
    "",
    `**Authors:** ${metadata.authors.join(", ")}`,
    `**arXiv:** https://arxiv.org/abs/${metadata.id}`,
    ...(tldr === undefined ? [] : [`**TLDR:** ${tldr}`]),
    "",
    "---",
    "",
    metadata.abstract,
    "",
    body,
  ].join("\n") + "\n"
}

const fetchAndCachePubmed = (
  id: string,
  dir: string,
  cacheFile: string,
  includeTldr: boolean
): Effect.Effect<string, GetError, PubmedClient> =>
  PubmedClient.use((pubmed) => pubmed.get(id)).pipe(
    Effect.mapError((error): GetError => ({ _tag: "GetPubmedError", error })),
    Effect.zipWith(includeTldr ? fetchTldr(`pmid:${id}`) : Effect.succeed(undefined), (metadata, tldr) => ({
      markdown: buildPubmedMarkdown(metadata, tldr),
      metadata,
    })),
    Effect.flatMap(({ markdown, metadata }) => writeCachedPaper(dir, cacheFile, markdown).pipe(
      Effect.andThen(writeMeta(dir, metadata.id, metadata.title, metadata.authors, `https://pubmed.ncbi.nlm.nih.gov/${id}/`)),
      Effect.as(markdown)
    ))
  )

const buildPubmedMarkdown = (metadata: PubmedPaperMetadata, tldr: string | undefined): string => [
  `# ${metadata.title}`,
  "",
  `**Authors:** ${metadata.authors.join(", ")}`,
  ...(metadata.journal === undefined ? [] : [`**Journal:** ${metadata.journal}`]),
  `**Published:** ${metadata.published}`,
  ...(metadata.doi === undefined ? [] : [`**DOI:** ${metadata.doi}`]),
  `**PubMed:** https://pubmed.ncbi.nlm.nih.gov/${metadata.id.slice("pmid:".length)}/`,
  ...(tldr === undefined ? [] : [`**TLDR:** ${tldr}`]),
  "",
  "---",
  "",
  "## Abstract",
  "",
  metadata.abstract,
].join("\n") + "\n"

const fetchAndCacheDoi = (
  doi: string,
  dir: string,
  cacheFile: string,
  includeTldr: boolean
): Effect.Effect<string, GetError, CrossrefClient> =>
  CrossrefClient.use((crossref) => crossref.get(doi)).pipe(
    Effect.mapError((error): GetError => ({ _tag: "GetCrossrefError", error })),
    Effect.zipWith(includeTldr ? fetchTldr(`doi:${doi}`) : Effect.succeed(undefined), (metadata, tldr) => ({
      markdown: buildDoiMarkdown(metadata, tldr),
      metadata,
    })),
    Effect.flatMap(({ markdown, metadata }) => writeCachedPaper(dir, cacheFile, markdown).pipe(
      Effect.andThen(writeMeta(dir, metadata.id, metadata.title, metadata.authors, metadata.fullTextUrl)),
      Effect.as(markdown)
    ))
  )

const buildDoiMarkdown = (metadata: CrossrefPaperMetadata, tldr: string | undefined): string => [
  `# ${metadata.title}`,
  "",
  `**Authors:** ${metadata.authors.join(", ")}`,
  `**Source:** ${metadata.source}`,
  `**Published:** ${metadata.published}`,
  `**DOI:** ${metadata.doi}`,
  `**Full text:** ${metadata.fullTextUrl}`,
  ...(tldr === undefined ? [] : [`**TLDR:** ${tldr}`]),
  "",
  "---",
  "",
  "## Abstract",
  "",
  metadata.abstract,
].join("\n") + "\n"

const renderMarkdown = (markdown: string, params: GetArxivParams): Effect.Effect<string, GetError> => {
  const withoutTldr = params.tldr ? markdown : stripTldr(markdown)
  const view = params.refs ? withoutTldr : stripReferences(withoutTldr)
  if (!params.detailed) return Effect.succeed(renderCompactOutput(view, params.id))
  if (params.range === undefined) return Effect.succeed(view)
  return renderRange(view, params.range)
}

const renderRange = (markdown: string, range: RangeSpec): Effect.Effect<string, GetError> => {
  const lines = renderLines(markdown)
  if (range.start > lines.length) {
    return Effect.fail({ _tag: "GetRangeError", message: `range start ${range.start} exceeds total lines ${lines.length}` })
  }
  const end = Math.min(range.end, lines.length)
  const title = titleFromMarkdown(markdown)
  return Effect.succeed([
    `# ${title} (lines ${range.start}-${end})`,
    "",
    `**Range:** ${range.start}-${end} of ${lines.length}`,
    "",
    lines.slice(range.start - 1, end).join("\n"),
  ].join("\n"))
}

const renderCompactOutput = (markdown: string, id: string): string => {
  const lines = renderLines(markdown)
  if (lines.length < 30) return markdown

  const sections = indexSections(lines)
  if (sections.length === 0) return markdown

  const title = titleFromMarkdown(markdown)
  const header = compactHeader(lines)
  const summary = leadParagraph(lines)
  const output = [`# ${title}`, ""]

  if (header.length > 0) {
    output.push(...header)
  }

  if (summary !== "") {
    output.push("", `**Summary:** ${summary}`)
  }

  output.push(
    "",
    "**Index:**",
    "| Section | Lines |",
    "|---------|-------|",
    ...sections.map((section) => `| ${escapeTableCell(section.title)} | ${section.start}-${section.end} |`),
    "",
    `> Fetch lines: \`paper7 get ${id} --detailed --range START:END\``,
    `> Full paper: \`paper7 get ${id} --detailed\``
  )

  return output.join("\n")
}

type IndexedSection = {
  readonly title: string
  readonly start: number
  readonly end: number
}

const indexSections = (lines: ReadonlyArray<string>): ReadonlyArray<IndexedSection> => {
  const sections: Array<IndexedSection> = []
  let current: { readonly title: string; readonly start: number } | undefined

  for (let index = 0; index < lines.length; index += 1) {
    if (index === 0) continue
    const title = headingTitle(lines[index] ?? "")
    if (title !== undefined) {
      if (current !== undefined) sections.push({ ...current, end: index })
      current = { title, start: index + 1 }
    }
  }

  if (current !== undefined) sections.push({ ...current, end: lines.length })
  return sections
}

const renderLines = (markdown: string): ReadonlyArray<string> => {
  const lines = markdown.split("\n")
  const lastIndex = lines.length - 1
  if (lines[lastIndex] === "") return lines.slice(0, lastIndex)
  return lines
}

const compactHeader = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const result: Array<string> = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (line === "---") return result
    if (line.trim() === "" || line.startsWith("**TLDR:**")) continue
    result.push(line)
  }
  return result
}

const leadParagraph = (lines: ReadonlyArray<string>): string => {
  let afterRule = false
  let text = ""
  for (const line of lines) {
    if (line === "---") {
      afterRule = true
      continue
    }
    if (!afterRule) continue
    if (headingTitle(line) !== undefined) {
      if (text !== "") break
      continue
    }
    if (line.trim() === "") {
      if (text !== "") break
      continue
    }
    text = text === "" ? line.trim() : `${text} ${line.trim()}`
  }
  return normalizeSummary(text)
}

const normalizeSummary = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= 600) return normalized
  return `${normalized.slice(0, 597)}...`
}

const titleFromMarkdown = (markdown: string): string => {
  const firstLine = markdown.split("\n")[0]
  if (firstLine === undefined) return "Untitled"
  const title = firstLine.replace(/^#\s+/, "").trim()
  return title === "" ? "Untitled" : title
}

const headingTitle = (line: string): string | undefined => {
  const match = /^(#{1,3})\s+(.+)$/.exec(line)
  const title = match?.[2]
  return title === undefined ? undefined : title
}

const escapeTableCell = (input: string): string => input.replace(/\|/g, "\\|")

const stripReferences = (markdown: string): string => {
  const lines = markdown.split("\n")
  const kept: Array<string> = []
  for (const line of lines) {
    if (/^## References\s*$/.test(line)) break
    kept.push(line)
  }
  return kept.join("\n")
}

const stripTldr = (markdown: string): string =>
  markdown.split("\n").filter((line) => !/^\*\*TLDR:\*\*/.test(line)).join("\n")

const wrapUntrusted = (markdown: string, source: string, id: string): string =>
  `<untrusted-content source="${escapeAttribute(source)}" id="${escapeAttribute(id)}">\n${markdown.trimEnd()}\n</untrusted-content>`

const safeDoiDir = (doi: string): string => doi.replace(/\//g, "_").replace(/[^A-Za-z0-9._-]/g, "_")

const arxivIdFromDoi = (doi: string): string | undefined => {
  const match = /^10\.48550\/arXiv\.(\d{4}\.\d{4,5})$/i.exec(doi)
  return match?.[1]
}

const htmlToMarkdown = (html: string): string => {
  const article = articleHtml(html)
  return normalizeMarkdown(decodeEntities(stripTags(markBlockTags(article))))
}

const articleHtml = (html: string): string => {
  const match = /<article(?:\s[^>]*)?>([\s\S]*?)<\/article>/.exec(html)
  const body = match === null ? undefined : match[1]
  return body ?? html
}

const markBlockTags = (html: string): string =>
  html
    .replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, "")
    .replace(/<span class="ltx_tag[^"]*">[\s\S]*?<\/span>/g, "")
    .replace(/<h1[^>]*>/g, "\n# ").replace(/<\/h1>/g, "\n")
    .replace(/<h2[^>]*>/g, "\n## ").replace(/<\/h2>/g, "\n")
    .replace(/<h3[^>]*>/g, "\n### ").replace(/<\/h3>/g, "\n")
    .replace(/<h4[^>]*>/g, "\n#### ").replace(/<\/h4>/g, "\n")
    .replace(/<p[^>]*>/g, "\n").replace(/<\/p>/g, "\n\n")
    .replace(/<br[^>]*>/g, "\n")
    .replace(/<li[^>]*>/g, "\n- ").replace(/<\/li>/g, "\n")
    .replace(/<strong[^>]*>/g, "**").replace(/<\/strong>/g, "**")
    .replace(/<em[^>]*>/g, "*").replace(/<\/em>/g, "*")
    .replace(/<code[^>]*>/g, "`").replace(/<\/code>/g, "`")
    .replace(/<blockquote[^>]*>/g, "\n> ").replace(/<\/blockquote>/g, "\n")

const stripTags = (html: string): string => html.replace(/<[^>]*>/g, "")

const normalizeMarkdown = (markdown: string): string => {
  const lines = markdown.split("\n")
  const normalized: Array<string> = []
  let previousBlank = true
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ").trim()
    if (line === "") {
      if (!previousBlank) normalized.push("")
      previousBlank = true
    } else {
      normalized.push(line)
      previousBlank = false
    }
  }
  return normalized.join("\n").trim()
}

const decodeEntities = (input: string): string =>
  input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")

const escapeAttribute = (input: string): string =>
  input.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
