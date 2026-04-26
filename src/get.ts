import { Effect } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Ar5ivClient, type Ar5ivError } from "./ar5iv.js"
import { ArxivClient, type ArxivError, type ArxivPaperMetadata } from "./arxiv.js"
import type { RangeSpec } from "./parser.js"

export type GetError =
  | { readonly _tag: "GetCacheReadError"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "GetCacheWriteError"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "GetRangeError"; readonly message: string }
  | { readonly _tag: "GetArxivError"; readonly error: ArxivError }
  | { readonly _tag: "GetAr5ivError"; readonly error: Ar5ivError }

export type GetArxivParams = {
  readonly id: string
  readonly cache: boolean
  readonly refs: boolean
  readonly detailed: boolean
  readonly range?: RangeSpec
}

export const getArxivPaper = (params: GetArxivParams): Effect.Effect<string, GetError, ArxivClient | Ar5ivClient> => {
  const dir = cacheDir(params.id)
  const cacheFile = join(dir, "paper.md")

  const paper = params.cache
    ? readCachedPaper(cacheFile).pipe(
        Effect.catch(() => fetchAndCache(params.id, dir, cacheFile))
      )
    : fetchAndCache(params.id, dir, cacheFile)

  return paper.pipe(
    Effect.flatMap((markdown) => renderMarkdown(markdown, params)),
    Effect.map((markdown) => wrapUntrusted(markdown, params.id))
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
      Ar5ivClient.use((ar5iv) => ar5iv.getHtml(id)).pipe(
        Effect.mapError((error): GetError => ({ _tag: "GetAr5ivError", error }))
      ),
      (metadata, html) => buildCanonicalMarkdown(metadata, html)
    ),
    Effect.flatMap((markdown) => writeCachedPaper(dir, cacheFile, markdown).pipe(Effect.as(markdown)))
  )

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

const buildCanonicalMarkdown = (metadata: ArxivPaperMetadata, html: string): string => {
  const body = htmlToMarkdown(html)
  return [
    `# ${metadata.title}`,
    "",
    `**Authors:** ${metadata.authors.join(", ")}`,
    `**arXiv:** https://arxiv.org/abs/${metadata.id}`,
    "",
    "---",
    "",
    metadata.abstract,
    "",
    body,
  ].join("\n") + "\n"
}

const renderMarkdown = (markdown: string, params: GetArxivParams): Effect.Effect<string, GetError> => {
  const withoutRefs = params.refs ? markdown : stripReferences(markdown)
  if (!params.detailed) return Effect.succeed(withoutRefs)
  if (params.range === undefined) return Effect.succeed(withoutRefs)
  return renderRange(withoutRefs, params.range)
}

const renderRange = (markdown: string, range: RangeSpec): Effect.Effect<string, GetError> => {
  const lines = markdown.split("\n")
  if (range.start > lines.length) {
    return Effect.fail({ _tag: "GetRangeError", message: `range start ${range.start} exceeds total lines ${lines.length}` })
  }
  const end = Math.min(range.end, lines.length)
  return Effect.succeed(lines.slice(range.start - 1, end).join("\n"))
}

const stripReferences = (markdown: string): string => {
  const lines = markdown.split("\n")
  const kept: Array<string> = []
  for (const line of lines) {
    if (/^## References\s*$/.test(line)) break
    kept.push(line)
  }
  return kept.join("\n")
}

const wrapUntrusted = (markdown: string, id: string): string =>
  `<untrusted-content source="arxiv" id="${escapeAttribute(id)}">\n${markdown.trimEnd()}\n</untrusted-content>`

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
