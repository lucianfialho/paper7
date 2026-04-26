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

export type CliCommand =
  | { readonly tag: "help" }
  | { readonly tag: "version" }
  | {
      readonly tag: "search"
      readonly query: string
      readonly source: Source
      readonly max: number
      readonly sort: SearchSort
    }
  | {
      readonly tag: "get"
      readonly id: PaperIdentifier
      readonly detailed: boolean
      readonly range?: RangeSpec
      readonly refs: boolean
      readonly cache: boolean
      readonly tldr: boolean
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

export type ParseResult =
  | { readonly ok: true; readonly command: CliCommand }
  | { readonly ok: false; readonly error: string }

const DEFAULT_MAX = 10

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

export const parseCliArgs = (args: ReadonlyArray<string>): ParseResult => {
  const first = args[0]
  if (first === undefined) return command({ tag: "help" })
  if (first === "help" || first === "--help" || first === "-h") return command({ tag: "help" })
  if (first === "--version" || first === "-v") return command({ tag: "version" })

  switch (first) {
    case "search":
      return parseSearch(args.slice(1))
    case "get":
      return parseGet(args.slice(1))
    case "refs":
      return parseRefs(args.slice(1))
    case "repo":
      return parseRepo(args.slice(1))
    case "list":
      return noArgs(args.slice(1), { tag: "list" })
    case "cache":
      return parseCache(args.slice(1))
    case "vault":
      return parseVault(args.slice(1))
    case "browse":
      return noArgs(args.slice(1), { tag: "browse" })
    default:
      return error(`unknown command: ${first}`)
  }
}

const parseSearch = (args: ReadonlyArray<string>): ParseResult => {
  const query = args[0]
  if (query === undefined || query.startsWith("-")) return error("search requires <query>")

  let source: Source = "arxiv"
  let max = DEFAULT_MAX
  let sort: SearchSort = "relevance"
  let index = 1
  while (index < args.length) {
    const option = args[index]
    if (option === "--source") {
      const value = args[index + 1]
      if (value !== "arxiv" && value !== "pubmed") return error("--source must be arxiv or pubmed")
      source = value
      index += 2
    } else if (option === "--max") {
      const value = parsePositiveOption("--max", args[index + 1])
      if (typeof value === "string") return error(value)
      max = value
      index += 2
    } else if (option === "--sort") {
      const value = args[index + 1]
      if (value !== "relevance" && value !== "date") return error("--sort must be relevance or date")
      sort = value
      index += 2
    } else {
      return error(`unknown search option: ${option ?? ""}`)
    }
  }

  return command({ tag: "search", query, source, max, sort })
}

const parseGet = (args: ReadonlyArray<string>): ParseResult => {
  const id = parseRequiredIdentifier("get", args[0])
  if (typeof id === "string") return error(id)

  let detailed = false
  let range: RangeSpec | undefined
  let refs = true
  let cache = true
  let tldr = true
  let index = 1
  while (index < args.length) {
    const option = args[index]
    if (option === "--detailed") {
      detailed = true
      index += 1
    } else if (option === "--range") {
      const parsed = args[index + 1] === undefined ? undefined : parseRangeSpec(args[index + 1])
      if (parsed === undefined) return error("invalid range: expected START:END")
      range = parsed
      index += 2
    } else if (option === "--no-refs") {
      refs = false
      index += 1
    } else if (option === "--no-cache") {
      cache = false
      index += 1
    } else if (option === "--no-tldr") {
      tldr = false
      index += 1
    } else {
      return error(`unknown get option: ${option ?? ""}`)
    }
  }

  if (range !== undefined && !detailed) return error("--range requires --detailed")

  return command({ tag: "get", id, detailed, range, refs, cache, tldr })
}

const parseRefs = (args: ReadonlyArray<string>): ParseResult => {
  const id = parseRequiredIdentifier("refs", args[0])
  if (typeof id === "string") return error(id)

  let max = DEFAULT_MAX
  let json = false
  let index = 1
  while (index < args.length) {
    const option = args[index]
    if (option === "--max") {
      const value = parsePositiveOption("--max", args[index + 1])
      if (typeof value === "string") return error(value)
      max = value
      index += 2
    } else if (option === "--json") {
      json = true
      index += 1
    } else {
      return error(`unknown refs option: ${option ?? ""}`)
    }
  }

  return command({ tag: "refs", id, max, json })
}

const parseRepo = (args: ReadonlyArray<string>): ParseResult => {
  const id = parseRequiredIdentifier("repo", args[0])
  if (typeof id === "string") return error(id)
  return noArgs(args.slice(1), { tag: "repo", id })
}

const parseCache = (args: ReadonlyArray<string>): ParseResult => {
  if (args[0] !== "clear") return error("cache requires clear")
  const rawId = args[1]
  if (rawId === undefined) return noArgs(args.slice(2), { tag: "cache-clear" })
  const id = parsePaperIdentifier(rawId)
  if (id === undefined) return error(`invalid paper id: ${rawId}`)
  return noArgs(args.slice(2), { tag: "cache-clear", id })
}

const parseVault = (args: ReadonlyArray<string>): ParseResult => {
  const first = args[0]
  if (first === undefined) return error("vault requires init, all, or <id>")
  if (first === "init") {
    const path = args[1]
    if (path === undefined) return error("vault init requires <path>")
    return noArgs(args.slice(2), { tag: "vault-init", path })
  }
  if (first === "all") return noArgs(args.slice(1), { tag: "vault-all" })

  const id = parsePaperIdentifier(first)
  if (id === undefined) return error(`invalid paper id: ${first}`)
  return noArgs(args.slice(1), { tag: "vault-export", id })
}

const parseRequiredIdentifier = (commandName: string, rawId: string | undefined): PaperIdentifier | string => {
  if (rawId === undefined) return `${commandName} requires <id>`
  const id = parsePaperIdentifier(rawId)
  if (id === undefined) return `invalid paper id: ${rawId}`
  return id
}

const parsePositiveOption = (name: string, value: string | undefined): number | string => {
  if (value === undefined || !/^\d+$/.test(value)) return `${name} requires a positive integer`
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return `${name} requires a positive integer`
  return parsed
}

const noArgs = (args: ReadonlyArray<string>, parsed: CliCommand): ParseResult => {
  const extra = args[0]
  if (extra !== undefined) return error(`unexpected argument: ${extra}`)
  return command(parsed)
}

const command = (parsed: CliCommand): ParseResult => ({ ok: true, command: parsed })

const error = (message: string): ParseResult => ({ ok: false, error: message })

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
