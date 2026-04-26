import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import type { PaperIdentifier } from "./parser.js"

export type RefsError =
  | { readonly _tag: "RefsHttpError"; readonly message: string }
  | { readonly _tag: "RefsDecodeError"; readonly message: string }

export type RefsParams = {
  readonly id: PaperIdentifier
  readonly max: number
  readonly json: boolean
}

export const getReferences = (params: RefsParams): Effect.Effect<string, RefsError> =>
  fetchRefsJson(params).pipe(
    Effect.flatMap((json) => params.json ? Effect.succeed(json.trimEnd()) : renderReferences(json, params.max))
  )

const fetchRefsJson = (params: RefsParams): Effect.Effect<string, RefsError> => {
  const fixturePath = process.env.PAPER7_S2_REFS_FIXTURE
  if (fixturePath !== undefined) {
    return Effect.tryPromise({
      try: () => readFile(fixturePath, { encoding: "utf8" }),
      catch: () => ({ _tag: "RefsHttpError", message: "failed to read Semantic Scholar fixture" }),
    })
  }

  const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2PaperId(params.id))}/references`)
  url.searchParams.set("fields", "externalIds,title,authors,year")
  url.searchParams.set("limit", String(params.max))
  url.searchParams.set("tool", "paper7")

  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`Semantic Scholar HTTP ${response.status}`)
      return response.text()
    },
    catch: (cause) => ({ _tag: "RefsHttpError", message: cause instanceof Error ? cause.message : "Semantic Scholar request failed" }),
  })
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

const renderReferences = (json: string, max: number): Effect.Effect<string, RefsError> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(json)
      if (!isRecord(parsed) || !Array.isArray(parsed.data)) return ""
      return parsed.data.slice(0, max).map(renderReference).filter((line) => line !== "").join("\n")
    },
    catch: () => ({ _tag: "RefsDecodeError", message: "failed to decode Semantic Scholar references" }),
  })

const renderReference = (value: unknown): string => {
  if (!isRecord(value) || !isRecord(value.citedPaper)) return ""
  const paper = value.citedPaper
  const id = referenceId(paper.externalIds, paper.paperId)
  const title = typeof paper.title === "string" && paper.title !== "" ? paper.title : "(no title)"
  const authors = authorNames(paper.authors)
  const year = typeof paper.year === "number" || typeof paper.year === "string" ? ` (${paper.year})` : ""
  return `  [${id}]  ${title}\n  ${authors}${year}\n`
}

const referenceId = (externalIds: unknown, paperId: unknown): string => {
  if (isRecord(externalIds)) {
    if (typeof externalIds.ArXiv === "string") return `arxiv:${externalIds.ArXiv}`
    if (typeof externalIds.PubMed === "string" || typeof externalIds.PubMed === "number") return `pmid:${externalIds.PubMed}`
    if (typeof externalIds.DOI === "string") return `doi:${externalIds.DOI}`
  }
  return typeof paperId === "string" ? `s2:${paperId}` : "s2:unknown"
}

const authorNames = (authors: unknown): string => {
  if (!Array.isArray(authors)) return ""
  const names: Array<string> = []
  for (const author of authors) {
    if (!isRecord(author) || typeof author.name !== "string") continue
    const parts = author.name.split(" ").filter((part) => part !== "")
    const last = parts[parts.length - 1]
    if (last !== undefined) names.push(last)
  }
  return names.slice(0, 5).join(", ").slice(0, 60)
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null
