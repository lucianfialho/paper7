import { Console, Effect, Stdio } from "effect"
import { browseCachedPapers, type BrowseError } from "../browse.js"
import { CachePaths } from "../cache.js"
import type { CliCommand } from "../parser.js"

export const runBrowseCommand = (
  _command: Extract<CliCommand, { readonly tag: "browse" }>
): Effect.Effect<void, BrowseError, CachePaths | Stdio.Stdio> =>
  browseCachedPapers().pipe(
    Effect.flatMap((result) => Console.log(result))
  )


