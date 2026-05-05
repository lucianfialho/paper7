import { Data, Effect } from "effect"
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Ar5ivClient } from "./ar5iv.js"
import type { ArxivClient } from "./arxiv.js"
import type { CrossrefClient } from "./crossref.js"
import { getPaper, type GetError } from "./get.js"
import type { CliCommand, PaperIdentifier } from "./parser.js"
import type { PubmedClient } from "./pubmed.js"
import type { SemanticScholarClient } from "./semanticScholar.js"

export class KbIoError extends Data.TaggedError("KbIoError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export class KbInvalidSlug extends Data.TaggedError("KbInvalidSlug")<{
  readonly slug: string
}> {}

export class KbGetError extends Data.TaggedError("KbGetError")<{
  readonly error: GetError
}> {}

export type KbError = KbIoError | KbInvalidSlug | KbGetError

type WikiPaths = {
  readonly root: string
  readonly sources: string
  readonly pages: string
  readonly index: string
  readonly log: string
}

export type KbEnvironment = Ar5ivClient | ArxivClient | CrossrefClient | PubmedClient | SemanticScholarClient

export const runKb = (command: Extract<CliCommand, { readonly tag: `kb-${string}` }>): Effect.Effect<string, KbError | GetError, KbEnvironment> => {
  switch (command.tag) {
    case "kb-ingest":
      return ingest(command.id)
    case "kb-read":
      return readKb(command.slug)
    case "kb-write":
      return writeKb(command.slug)
    case "kb-search":
      return searchKb(command.pattern)
    case "kb-list":
      return listKb()
    case "kb-status":
      return statusKb()
  }
}

const ingest = (id: PaperIdentifier): Effect.Effect<string, KbError | GetError, KbEnvironment> => {
  const paths = wikiPaths()
  const sourceName = sourceFileName(id)
  return ensureWiki(paths).pipe(
    Effect.andThen(getPaper({ tag: "get", id, detailed: true, refs: true, cache: true, tldr: true, abstractOnly: false })),
    Effect.flatMap((paper) => writeText(join(paths.sources, sourceName), paper).pipe(Effect.as(paper)))
  )
}

const readKb = (slug: string): Effect.Effect<string, KbError> =>
  validateReadableSlug(slug).pipe(
    Effect.flatMap((validSlug) => {
      const paths = wikiPaths()
      const file = validSlug === "index" ? paths.index : validSlug === "log" ? paths.log : join(paths.pages, `${validSlug}.md`)
      return ensureWiki(paths).pipe(Effect.andThen(readText(file)))
    })
  )

const writeKb = (slug: string): Effect.Effect<string, KbError> =>
  validatePageSlug(slug).pipe(
    Effect.flatMap((validSlug) => {
      const paths = wikiPaths()
      return ensureWiki(paths).pipe(
        Effect.andThen(readStdin),
        Effect.flatMap((content) => writeText(join(paths.pages, `${validSlug}.md`), content).pipe(Effect.as(content))),
        Effect.flatMap(() => refreshIndex(paths)),
        Effect.flatMap(() => appendLog(paths, `write ${validSlug}`)),
        Effect.as(`Wrote ${validSlug}`)
      )
    })
  )

const searchKb = (pattern: string): Effect.Effect<string, KbError> => {
  const paths = wikiPaths()
  const needle = pattern.toLowerCase()
  return ensureWiki(paths).pipe(
    Effect.andThen(listMarkdownFiles(paths.pages)),
    Effect.flatMap((files) => Effect.forEach(files, (file) => readText(join(paths.pages, file)).pipe(
      Effect.map((content) => ({ file, content }))
    ))),
    Effect.map((pages) => pages.flatMap(({ file, content }) => matchingLines(file, content, needle)).join("\n") || "No matches")
  )
}

const listKb = (): Effect.Effect<string, KbError> => {
  const paths = wikiPaths()
  return ensureWiki(paths).pipe(
    Effect.andThen(Effect.zip(listMarkdownFiles(paths.pages), listMarkdownFiles(paths.sources))),
    Effect.map(([pages, sources]) => [
      "Pages:",
      ...(pages.length === 0 ? ["- none"] : pages.map((page) => `- ${page.replace(/\.md$/, "")}`)),
      "",
      "Sources:",
      ...(sources.length === 0 ? ["- none"] : sources.map((source) => `- ${source.replace(/\.md$/, "")}`)),
    ].join("\n"))
  )
}

const statusKb = (): Effect.Effect<string, KbError> => {
  const paths = wikiPaths()
  return ensureWiki(paths).pipe(
    Effect.andThen(Effect.zip(listMarkdownFiles(paths.pages), listMarkdownFiles(paths.sources))),
    Effect.map(([pages, sources]) => [
      `Wiki: ${paths.root}`,
      `Pages: ${pages.length}`,
      `Sources: ${sources.length}`,
    ].join("\n"))
  )
}

const ensureWiki = (paths: WikiPaths): Effect.Effect<void, KbError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(paths.sources, { recursive: true })
      await mkdir(paths.pages, { recursive: true })
      await ensureFile(paths.index, "# paper7 wiki\n\n")
      await ensureFile(paths.log, "# paper7 wiki log\n\n")
    },
    catch: (cause): KbError => new KbIoError({ message: "failed to initialize wiki", cause }),
  })

const refreshIndex = (paths: WikiPaths): Effect.Effect<void, KbError> =>
  listMarkdownFiles(paths.pages).pipe(
    Effect.flatMap((pages) => writeText(paths.index, [
      "# paper7 wiki",
      "",
      ...pages.map((page) => `- [${page.replace(/\.md$/, "")}](pages/${page})`),
      "",
    ].join("\n")))
  )

const appendLog = (paths: WikiPaths, message: string): Effect.Effect<void, KbError> =>
  Effect.tryPromise({
    try: () => appendFile(paths.log, `${new Date().toISOString()} ${message}\n`, { encoding: "utf8" }),
    catch: (cause): KbError => new KbIoError({ message: "failed to append wiki log", cause }),
  })

const listMarkdownFiles = (dir: string): Effect.Effect<ReadonlyArray<string>, KbError> =>
  Effect.tryPromise({
    try: async () => (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort(),
    catch: (cause): KbError => new KbIoError({ message: `failed to list ${dir}`, cause }),
  })

const readText = (file: string): Effect.Effect<string, KbError> =>
  Effect.tryPromise({
    try: () => readFile(file, { encoding: "utf8" }),
    catch: (cause): KbError => new KbIoError({ message: `failed to read ${file}`, cause }),
  })

const writeText = (file: string, content: string): Effect.Effect<void, KbError> =>
  Effect.tryPromise({
    try: () => writeFile(file, content, { encoding: "utf8" }),
    catch: (cause): KbError => new KbIoError({ message: `failed to write ${file}`, cause }),
  })

const readStdin: Effect.Effect<string, KbError> =
  Effect.tryPromise({
    try: () => new Promise<string>((resolve, reject) => {
      let content = ""
      process.stdin.setEncoding("utf8")
      process.stdin.on("data", (chunk) => {
        content += String(chunk)
      })
      process.stdin.on("end", () => resolve(content))
      process.stdin.on("error", reject)
    }),
    catch: (cause): KbError => new KbIoError({ message: "failed to read stdin", cause }),
  })

const validateReadableSlug = (slug: string): Effect.Effect<string, KbError> =>
  slug === "index" || slug === "log" ? Effect.succeed(slug) : validatePageSlug(slug)

const validatePageSlug = (slug: string): Effect.Effect<string, KbError> =>
  /^[a-z0-9][a-z0-9-]*$/.test(slug) && slug !== "index" && slug !== "log"
    ? Effect.succeed(slug)
    : Effect.fail(new KbInvalidSlug({ slug }))

const matchingLines = (file: string, content: string, needle: string): ReadonlyArray<string> =>
  content.split("\n").flatMap((line, index) => line.toLowerCase().includes(needle) ? [`${file}:${index + 1}: ${line}`] : [])

const sourceFileName = (id: PaperIdentifier): string => {
  switch (id.tag) {
    case "arxiv":
      return `arxiv-${id.id}.md`
    case "pubmed":
      return `pmid-${id.id}.md`
    case "doi":
      return `doi-${id.id.replace(/[^a-zA-Z0-9.-]/g, "_")}.md`
  }
}

const wikiPaths = (): WikiPaths => {
  const home = process.env.HOME ?? "."
  const root = join(home, ".paper7", "wiki")
  return {
    root,
    sources: join(root, "sources"),
    pages: join(root, "pages"),
    index: join(root, "index.md"),
    log: join(root, "log.md"),
  }
}

const ensureFile = async (file: string, content: string): Promise<void> => {
  try {
    await readFile(file, { encoding: "utf8" })
  } catch {
    await writeFile(file, content, { encoding: "utf8" })
  }
}
