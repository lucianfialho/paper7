import { Console, Effect } from "effect"
import type { ArxivClient } from "../arxiv.js"
import { citePaper, type CitationError } from "../cite.js"
import type { CrossrefClient } from "../crossref.js"
import type { CliCommand } from "../parser.js"
import type { PubmedClient } from "../pubmed.js"

export const runCiteCommand = (
  command: Extract<CliCommand, { readonly tag: "cite" }>
): Effect.Effect<void, CitationError, ArxivClient | CrossrefClient | PubmedClient> =>
  citePaper(command).pipe(Effect.flatMap((citation) => Console.log(citation)))
