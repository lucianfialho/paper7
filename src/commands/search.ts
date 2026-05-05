import { Console, Effect, Option } from "effect"
import { ArxivClient, type ArxivError, type ArxivSearchResult } from "../arxiv.js"
import { CachePaths, type CacheError } from "../cache.js"
import { PubmedClient, type PubmedError, type PubmedSearchResult } from "../pubmed.js"
import { readSearchCache, writeSearchCache } from "../searchCache.js"
import type { CliCommand } from "../parser.js"

export const runSearchCommand = (
  command: Extract<CliCommand, { readonly tag: "search" }>
): Effect.Effect<void, ArxivError | PubmedError | CacheError, ArxivClient | PubmedClient | CachePaths> =>
  Effect.gen(function*() {
    if (!command.cache) {
      if (command.source === "pubmed") {
        const result = yield* PubmedClient.use((client) => client.search(command))
        yield* Console.log(renderPubmedSearch(command.query, command.max, result))
        return
      }
      const result = yield* ArxivClient.use((client) => client.search(command))
      yield* Console.log(renderArxivSearch(command.query, command.max, result))
      return
    }

    if (command.source === "pubmed") {
      const params = { source: "pubmed" as const, query: command.query, max: command.max, sort: command.sort }
      const cached = yield* readSearchCache(params)
      if (Option.isSome(cached)) {
        yield* Console.log(renderPubmedSearch(command.query, command.max, cached.value))
        return
      }
      const result = yield* PubmedClient.use((client) => client.search(command))
      yield* writeSearchCache(params, result).pipe(
        Effect.catch((error: CacheError) =>
          Console.error(formatCacheError(error)).pipe(Effect.andThen(Effect.succeed(undefined)))
        )
      )
      yield* Console.log(renderPubmedSearch(command.query, command.max, result))
      return
    }

    const params = { source: "arxiv" as const, query: command.query, max: command.max, sort: command.sort }
    const cached = yield* readSearchCache(params)
    if (Option.isSome(cached)) {
      yield* Console.log(renderArxivSearch(command.query, command.max, cached.value))
      return
    }
    const result = yield* ArxivClient.use((client) => client.search(command))
    yield* writeSearchCache(params, result).pipe(
      Effect.catch((error: CacheError) =>
        Console.error(formatCacheError(error)).pipe(Effect.andThen(Effect.succeed(undefined)))
      )
    )
    yield* Console.log(renderArxivSearch(command.query, command.max, result))
  })

export const renderArxivSearch = (query: string, max: number, result: ArxivSearchResult): string => {
  if (result.total === 0) return `No papers found for: ${query}`

  const lines = [`Found ${result.total} papers (showing ${max}):`, ""]
  for (const warning of result.warnings) lines.push(warning)
  if (result.warnings.length > 0) lines.push("")

  for (const paper of result.papers) {
    const authors = truncateAuthors(paper.authors.join(", "))
    lines.push(`  [${paper.id}] ${paper.title}`)
    lines.push(`  ${authors} (${paper.published})`)
    lines.push("")
  }

  return lines.join("\n")
}

export const renderPubmedSearch = (query: string, max: number, result: PubmedSearchResult): string => {
  if (result.total === 0) return `No papers found for: ${query}`

  const lines = [`Found ${result.total} papers (showing ${max}):`, ""]
  for (const warning of result.warnings) lines.push(warning)
  if (result.warnings.length > 0) lines.push("")

  for (const paper of result.papers) {
    const authors = truncateAuthors(paper.authors.join(", "))
    lines.push(`  [${paper.id}] ${paper.title}`)
    lines.push(`  ${authors} (${paper.published})`)
    lines.push("")
  }

  return lines.join("\n")
}

const truncateAuthors = (authors: string): string => {
  if (authors.length <= 60) return authors
  return `${authors.slice(0, 57)}...`
}

const formatCacheError = (error: CacheError): string => {
  switch (error._tag) {
    case "CacheFsError":
      return `error: cache failure: ${error.message}`
  }
}
