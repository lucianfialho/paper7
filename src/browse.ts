import { Data, Effect, Option, Stdio, Stream } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { cacheDirForIdentifierAt, CachePaths, listCachedPapers, type CacheEntry, type CacheError } from "./cache.js"
import { parsePaperIdentifier } from "./parser.js"

export class BrowseCacheError extends Data.TaggedError("BrowseCacheError")<{
  readonly error: CacheError
}> {}

export class BrowseInvalidSelection extends Data.TaggedError("BrowseInvalidSelection")<{
  readonly message: string
}> {}

export class BrowseCacheMissing extends Data.TaggedError("BrowseCacheMissing")<{
  readonly message: string
  readonly id: string
}> {}

export class BrowseCacheMalformed extends Data.TaggedError("BrowseCacheMalformed")<{
  readonly message: string
  readonly id: string
}> {}

export class BrowseIoError extends Data.TaggedError("BrowseIoError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export type BrowseError =
  | BrowseCacheError
  | BrowseInvalidSelection
  | BrowseCacheMissing
  | BrowseCacheMalformed
  | BrowseIoError

type Selection =
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "selected"; readonly index: number }

export const browseCachedPapers = (): Effect.Effect<string, BrowseError, CachePaths | Stdio.Stdio> =>
  listCachedPapers().pipe(
    Effect.mapError((error): BrowseError => new BrowseCacheError({ error })),
    Effect.flatMap((result) => {
      if (result.entries.length === 0) return Effect.succeed("No papers cached")
      return promptForSelection(result.entries).pipe(
        Effect.flatMap((selection) => {
          if (selection._tag === "cancelled") return Effect.succeed("Browse cancelled")
          const entry = result.entries[selection.index]
          if (entry === undefined) {
            return Effect.fail(new BrowseInvalidSelection({ message: "invalid selection" }))
          }
          return readSelectedPaper(entry)
        })
      )
    })
  )

const promptForSelection = (
  entries: ReadonlyArray<CacheEntry>
): Effect.Effect<Selection, BrowseError, Stdio.Stdio> =>
  writeStdout(`${renderBrowsePrompt(entries)}> `).pipe(
    Effect.andThen(readStdinLine),
    Effect.map((input) => parseSelection(input, entries.length)),
    Effect.flatMap((selection) => typeof selection === "string"
      ? Effect.fail(invalidSelection(selection))
      : Effect.succeed(selection)
    )
  )

const readSelectedPaper = (entry: CacheEntry): Effect.Effect<string, BrowseError, CachePaths> => {
  const id = parsePaperIdentifier(entry.id)
  if (id === undefined) {
    return Effect.fail(new BrowseCacheMalformed({ message: `invalid cached paper id: ${entry.id}`, id: entry.id }))
  }

  return CachePaths.use((paths) =>
    Effect.tryPromise({
      try: () => readFile(join(cacheDirForIdentifierAt(paths.cacheRoot, id), "paper.md"), { encoding: "utf8" }),
      catch: (cause): BrowseError => isMissing(cause)
        ? new BrowseCacheMissing({ message: `no cached paper for ${entry.id}`, id: entry.id })
        : new BrowseIoError({ message: `failed to read cached paper for ${entry.id}`, cause }),
    })
  )
}

const writeStdout = (text: string): Effect.Effect<void, BrowseError, Stdio.Stdio> =>
  Stdio.Stdio.use((stdio) =>
    Stream.make(text).pipe(
      Stream.run(stdio.stdout()),
      Effect.mapError((cause): BrowseError => new BrowseIoError({ message: "failed to write browse prompt", cause }))
    )
  )

const readStdinLine: Effect.Effect<string, BrowseError, Stdio.Stdio> =
  Stdio.Stdio.use((stdio) =>
    stdio.stdin.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runHead,
      Effect.map((line) => Option.isNone(line) ? "" : line.value),
      Effect.mapError((cause): BrowseError => new BrowseIoError({ message: "failed to read selection", cause }))
    )
  )

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

const invalidSelection = (message: string): BrowseError => new BrowseInvalidSelection({ message })

const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
