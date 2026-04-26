import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { stdin as defaultInput, stdout as defaultOutput } from "node:process"
import { createInterface } from "node:readline/promises"
import type { Readable, Writable } from "node:stream"
import { join } from "node:path"
import { cacheDirForIdentifier, listCachedPapers, type CacheEntry, type CacheError } from "./cache.js"
import { parsePaperIdentifier } from "./parser.js"

export type BrowseError =
  | { readonly _tag: "BrowseCacheError"; readonly error: CacheError }
  | { readonly _tag: "BrowseInvalidSelection"; readonly message: string }
  | { readonly _tag: "BrowseCacheMissing"; readonly message: string; readonly id: string }
  | { readonly _tag: "BrowseCacheMalformed"; readonly message: string; readonly id: string }
  | { readonly _tag: "BrowseIoError"; readonly message: string; readonly cause: unknown }

type Selection =
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "selected"; readonly index: number }

export const browseCachedPapers = (
  input: Readable = defaultInput,
  output: Writable = defaultOutput
): Effect.Effect<string, BrowseError> =>
  listCachedPapers().pipe(
    Effect.mapError((error): BrowseError => ({ _tag: "BrowseCacheError", error })),
    Effect.flatMap((result) => {
      if (result.entries.length === 0) return Effect.succeed("No papers cached")
      return promptForSelection(result.entries, input, output).pipe(
        Effect.flatMap((selection) => {
          if (selection._tag === "cancelled") return Effect.succeed("Browse cancelled")
          const entry = result.entries[selection.index]
          if (entry === undefined) {
            const error: BrowseError = { _tag: "BrowseInvalidSelection", message: "invalid selection" }
            return Effect.fail(error)
          }
          return readSelectedPaper(entry)
        })
      )
    })
  )

const promptForSelection = (
  entries: ReadonlyArray<CacheEntry>,
  input: Readable,
  output: Writable
): Effect.Effect<Selection, BrowseError> =>
  Effect.tryPromise({
    try: async () => {
      output.write(renderBrowsePrompt(entries))
      const rl = createInterface({ input, output })
      try {
        const answer = await rl.question("> ")
        return parseSelection(answer, entries.length)
      } finally {
        rl.close()
      }
    },
    catch: (cause): BrowseError => ({ _tag: "BrowseIoError", message: "failed to read selection", cause }),
  }).pipe(
    Effect.flatMap((selection) => typeof selection === "string"
      ? Effect.fail(invalidSelection(selection))
      : Effect.succeed(selection)
    )
  )

const readSelectedPaper = (entry: CacheEntry): Effect.Effect<string, BrowseError> => {
  const id = parsePaperIdentifier(entry.id)
  if (id === undefined) {
    return Effect.fail({ _tag: "BrowseCacheMalformed", message: `invalid cached paper id: ${entry.id}`, id: entry.id })
  }

  return Effect.tryPromise({
    try: () => readFile(join(cacheDirForIdentifier(id), "paper.md"), { encoding: "utf8" }),
    catch: (cause): BrowseError => isMissing(cause)
      ? { _tag: "BrowseCacheMissing", message: `no cached paper for ${entry.id}`, id: entry.id }
      : { _tag: "BrowseIoError", message: `failed to read cached paper for ${entry.id}`, cause },
  })
}

const renderBrowsePrompt = (entries: ReadonlyArray<CacheEntry>): string => {
  const lines = ["Cached papers:"]
  for (const [index, entry] of entries.entries()) {
    lines.push(`${index + 1}. [${entry.id}] ${entry.title}`)
  }
  lines.push("Select paper number, or q to cancel")
  return `${lines.join("\n")}\n`
}

const parseSelection = (input: string, count: number): Selection | string => {
  const trimmed = input.trim().toLowerCase()
  if (trimmed === "" || trimmed === "q" || trimmed === "quit") return { _tag: "cancelled" }
  if (!/^\d+$/.test(trimmed)) return "invalid selection"
  const selected = Number(trimmed)
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > count) return "invalid selection"
  return { _tag: "selected", index: selected - 1 }
}

const invalidSelection = (message: string): BrowseError => ({ _tag: "BrowseInvalidSelection", message })

const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
