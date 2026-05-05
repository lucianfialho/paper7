import { Console, Effect } from "effect"
import type { Ar5ivClient } from "../ar5iv.js"
import type { ArxivClient } from "../arxiv.js"
import type { CrossrefClient } from "../crossref.js"
import { getPaper, type GetError } from "../get.js"
import type { CliCommand } from "../parser.js"
import type { PubmedClient } from "../pubmed.js"
import type { SemanticScholarClient } from "../semanticScholar.js"

export const runGetCommand = (
  command: Extract<CliCommand, { readonly tag: "get" }>
): Effect.Effect<void, GetError, Ar5ivClient | ArxivClient | CrossrefClient | PubmedClient | SemanticScholarClient> =>
  getPaper(command).pipe(
    Effect.flatMap((markdown) => Console.log(markdown))
  )
