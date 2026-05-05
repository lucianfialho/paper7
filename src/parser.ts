export type PaperIdentifier =
  | { readonly tag: "arxiv"; readonly id: string }
  | { readonly tag: "pubmed"; readonly id: string }
  | { readonly tag: "doi"; readonly id: string }

export type RangeSpec = {
  readonly start: number
  readonly end: number
}

export type Source = "arxiv" | "pubmed"
export type SearchSort = "relevance" | "date"
export type CitationFormat = "bibtex" | "apa" | "abnt"

export type CliCommand =
  | {
      readonly tag: "search"
      readonly query: string
      readonly source: Source
      readonly max: number
      readonly sort: SearchSort
      readonly cache: boolean
    }
  | {
      readonly tag: "get"
      readonly id: PaperIdentifier
      readonly detailed: boolean
      readonly range?: RangeSpec
      readonly refs: boolean
      readonly cache: boolean
      readonly tldr: boolean
      readonly abstractOnly: boolean
    }
  | {
      readonly tag: "cite"
      readonly id: PaperIdentifier
      readonly format: CitationFormat
    }
  | {
      readonly tag: "refs"
      readonly id: PaperIdentifier
      readonly max: number
      readonly json: boolean
    }
  | { readonly tag: "repo"; readonly id: PaperIdentifier }
  | { readonly tag: "list" }
  | { readonly tag: "cache-clear"; readonly id?: PaperIdentifier }
  | { readonly tag: "vault-init"; readonly path: string }
  | { readonly tag: "vault-export"; readonly id: PaperIdentifier }
  | { readonly tag: "vault-all" }
  | { readonly tag: "browse" }
  | { readonly tag: "kb-ingest"; readonly id: PaperIdentifier }
  | { readonly tag: "kb-read"; readonly slug: string }
  | { readonly tag: "kb-write"; readonly slug: string }
  | { readonly tag: "kb-search"; readonly pattern: string }
  | { readonly tag: "kb-list" }
  | { readonly tag: "kb-status" }

export const parseRangeSpec = (input: string): RangeSpec | undefined => {
  const match = /^(\d+):(\d+)$/.exec(input)
  if (match === null) return undefined

  const startText = match[1]
  const endText = match[2]
  if (startText === undefined || endText === undefined) return undefined

  const start = Number(startText)
  const end = Number(endText)
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined
  if (start < 1 || end < start) return undefined

  return { start, end }
}

export const parsePaperIdentifier = (input: string): PaperIdentifier | undefined => {
  const pubmedUrl = parsePubMedUrl(input)
  if (pubmedUrl !== undefined) return { tag: "pubmed", id: pubmedUrl }

  if (input.startsWith("pmid:")) {
    const id = input.slice("pmid:".length)
    if (/^\d+$/.test(id)) return { tag: "pubmed", id }
    return undefined
  }

  if (input.startsWith("doi:")) {
    const id = input.slice("doi:".length)
    if (/^10\.\d{4,9}\/.+$/i.test(id)) return { tag: "doi", id }
    return undefined
  }

  const arxivUrl = parseArxivUrl(input)
  if (arxivUrl !== undefined) return { tag: "arxiv", id: arxivUrl }

  const arxivId = normalizeArxivId(input)
  if (arxivId !== undefined) return { tag: "arxiv", id: arxivId }

  return undefined
}

const parseArxivUrl = (input: string): string | undefined => {
  const prefixes = [
    "https://arxiv.org/abs/",
    "http://arxiv.org/abs/",
    "https://arxiv.org/pdf/",
    "http://arxiv.org/pdf/",
    "https://ar5iv.labs.arxiv.org/html/",
    "http://ar5iv.labs.arxiv.org/html/",
  ]

  for (const prefix of prefixes) {
    if (input.startsWith(prefix)) {
      const [pathWithSuffix = ""] = input.slice(prefix.length).split(/[?#]/)
      const path = pathWithSuffix.endsWith("/") ? pathWithSuffix.slice(0, -1) : pathWithSuffix
      return normalizeArxivId(path.replace(/\.pdf$/, ""))
    }
  }

  return undefined
}

const parsePubMedUrl = (input: string): string | undefined => {
  const prefixes = ["https://pubmed.ncbi.nlm.nih.gov/", "http://pubmed.ncbi.nlm.nih.gov/"]
  for (const prefix of prefixes) {
    if (input.startsWith(prefix)) {
      const path = input.slice(prefix.length).split(/[/?#]/)[0]
      if (path === undefined) return undefined
      return /^\d+$/.test(path) ? path : undefined
    }
  }
  return undefined
}

const normalizeArxivId = (input: string): string | undefined => {
  const withoutSuffix = input.replace(/v\d+$/, "")
  return /^\d{4}\.\d{4,5}$/.test(withoutSuffix) ? withoutSuffix : undefined
}
