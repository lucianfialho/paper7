import { Console, Effect } from "effect"
import { CachePaths, clearCachedPapers, listCachedPapers, type CacheClearResult, type CacheError, type CacheListResult } from "../cache.js"
import type { CliCommand } from "../parser.js"

export const runCacheCommand = (
  command: Extract<CliCommand, { readonly tag: "list" | "cache-clear" }>
): Effect.Effect<void, CacheError, CachePaths> =>
  Effect.gen(function*() {
    switch (command.tag) {
      case "list": {
        const result = yield* listCachedPapers()
        yield* Console.log(renderCacheList(result))
        return
      }
      case "cache-clear": {
        const result = yield* clearCachedPapers(command.id)
        yield* Console.log(renderCacheClear(result))
        return
      }
    }
  })

const renderCacheList = (result: CacheListResult): string => {
  const lines: Array<string> = [...result.warnings]
  if (result.entries.length === 0) {
    if (lines.length > 0) lines.push("")
    lines.push("No cached papers")
    return lines.join("\n")
  }

  if (lines.length > 0) lines.push("")
  lines.push(`Cached papers (${result.entries.length}):`, "")
  for (const entry of result.entries) {
    lines.push(`  [${entry.id}] ${entry.title}`)
    if (entry.authors !== undefined) lines.push(`  ${truncateAuthors(entry.authors)}`)
    if (entry.url !== undefined) lines.push(`  ${entry.url}`)
    lines.push("")
  }
  return lines.join("\n")
}

const renderCacheClear = (result: CacheClearResult): string => {
  switch (result._tag) {
    case "cleared-all":
      return "Cleared paper7 cache"
    case "cleared-one":
      return `Cleared cache for ${result.id}`
    case "missing":
      return result.id === undefined ? "No paper7 cache found" : `No cache entry for ${result.id}`
  }
}

const truncateAuthors = (authors: string): string => {
  if (authors.length <= 60) return authors
  return `${authors.slice(0, 57)}...`
}


