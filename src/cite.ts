import { Effect } from "effect"
import { ArxivClient, type ArxivError, type ArxivPaperMetadata } from "./arxiv.js"
import { CrossrefClient, type CrossrefError, type CrossrefPaperMetadata } from "./crossref.js"
import type { CitationFormat, CliCommand, PaperIdentifier } from "./parser.js"
import { PubmedClient, type PubmedError, type PubmedPaperMetadata } from "./pubmed.js"

export type CitationError = ArxivError | CrossrefError | PubmedError

type CitationMetadata = {
  readonly title: string
  readonly authors: ReadonlyArray<string>
  readonly year: string
  readonly journal: string
  readonly doi?: string
}

export const citePaper = (
  command: Extract<CliCommand, { readonly tag: "cite" }>
): Effect.Effect<string, CitationError, ArxivClient | CrossrefClient | PubmedClient> =>
  loadCitationMetadata(command.id).pipe(
    Effect.map((metadata) => renderCitation(metadata, command.format))
  )

const loadCitationMetadata = (id: PaperIdentifier): Effect.Effect<CitationMetadata, CitationError, ArxivClient | CrossrefClient | PubmedClient> => {
  switch (id.tag) {
    case "arxiv":
      return ArxivClient.use((client) => client.get(id.id)).pipe(Effect.map(fromArxiv))
    case "doi":
      return CrossrefClient.use((client) => client.get(id.id)).pipe(Effect.map(fromCrossref))
    case "pubmed":
      return PubmedClient.use((client) => client.get(id.id)).pipe(Effect.map(fromPubmed))
  }
}

const fromArxiv = (metadata: ArxivPaperMetadata): CitationMetadata => ({
  title: metadata.title,
  authors: metadata.authors,
  year: yearFromText(metadata.published),
  journal: "arXiv preprint",
  doi: `10.48550/arXiv.${metadata.id}`,
})

const fromCrossref = (metadata: CrossrefPaperMetadata): CitationMetadata => ({
  title: metadata.title,
  authors: metadata.authors,
  year: yearFromText(metadata.published),
  journal: metadata.source,
  doi: metadata.doi,
})

const fromPubmed = (metadata: PubmedPaperMetadata): CitationMetadata => ({
  title: metadata.title,
  authors: metadata.authors,
  year: yearFromText(metadata.published),
  journal: metadata.journal ?? "PubMed",
  doi: metadata.doi,
})

const renderCitation = (metadata: CitationMetadata, format: CitationFormat): string => {
  switch (format) {
    case "bibtex":
      return renderBibtex(metadata)
    case "apa":
      return renderApa(metadata)
    case "abnt":
      return renderAbnt(metadata)
  }
}

const renderBibtex = (metadata: CitationMetadata): string => {
  const key = citationKey(metadata)
  const lines = [
    `@article{${key},`,
    `  title = {${metadata.title}},`,
    `  author = {${metadata.authors.join(" and ")}},`,
    `  journal = {${metadata.journal}},`,
    `  year = {${metadata.year}},`,
    ...(metadata.doi === undefined ? [] : [`  doi = {${metadata.doi}},`]),
    "}",
  ]
  return lines.join("\n")
}

const renderApa = (metadata: CitationMetadata): string => {
  const doi = metadata.doi === undefined ? "" : ` https://doi.org/${metadata.doi}`
  return `${formatApaAuthors(metadata.authors)} (${metadata.year}). ${metadata.title}. *${metadata.journal}*.${doi}`
}

const renderAbnt = (metadata: CitationMetadata): string => {
  const doi = metadata.doi === undefined ? "" : ` Disponível em: https://doi.org/${metadata.doi}.`
  return `${formatAbntAuthors(metadata.authors)}. ${metadata.title}. *${metadata.journal}*, ${metadata.year}.${doi}`
}

const citationKey = (metadata: CitationMetadata): string => {
  const author = lastName(metadata.authors[0] ?? "paper").toLowerCase().replace(/[^a-z0-9]/g, "")
  const titleWord = metadata.title.split(/\s+/).map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, "")).find((word) => word.length > 3) ?? "paper"
  return `${author}${metadata.year}${titleWord}`
}

const formatApaAuthors = (authors: ReadonlyArray<string>): string => {
  const formatted = authors.map(formatApaAuthor)
  if (formatted.length === 0) return "Unknown"
  if (formatted.length === 1) return formatted[0] ?? "Unknown"
  const last = formatted[formatted.length - 1]
  const rest = formatted.slice(0, -1)
  return last === undefined ? rest.join(", ") : `${rest.join(", ")}, & ${last}`
}

const formatApaAuthor = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter((part) => part !== "")
  const surname = parts[parts.length - 1]
  if (surname === undefined) return name
  const initials = parts.slice(0, -1).map((part) => `${part.slice(0, 1)}.`).join(" ")
  return initials === "" ? surname : `${surname}, ${initials}`
}

const formatAbntAuthors = (authors: ReadonlyArray<string>): string => {
  if (authors.length === 0) return "UNKNOWN"
  if (authors.length > 3) return `${formatAbntAuthor(authors[0] ?? "UNKNOWN")} et al`
  return authors.map(formatAbntAuthor).join("; ")
}

const formatAbntAuthor = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter((part) => part !== "")
  const surname = parts[parts.length - 1]
  if (surname === undefined) return name.toUpperCase()
  const initials = parts.slice(0, -1).map((part) => `${part.slice(0, 1)}.`).join(" ")
  return initials === "" ? surname.toUpperCase() : `${surname.toUpperCase()}, ${initials}`
}

const lastName = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter((part) => part !== "")
  return parts[parts.length - 1] ?? name
}

const yearFromText = (text: string): string => {
  const match = /\b(\d{4})\b/.exec(text)
  return match?.[1] ?? "n.d."
}
