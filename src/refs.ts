import { Data, Effect } from "effect"
import type { PaperIdentifier } from "./parser.js"
import { SemanticScholarClient, type S2Reference, type SemanticScholarError } from "./semanticScholar.js"

export class RefsSemanticScholarError extends Data.TaggedError("RefsSemanticScholarError")<{
  readonly error: SemanticScholarError
}> {}

export type RefsError = RefsSemanticScholarError

export type RefsParams = {
  readonly id: PaperIdentifier
  readonly max: number
  readonly json: boolean
}

export const getReferences = (params: RefsParams): Effect.Effect<string, RefsError, SemanticScholarClient> =>
  SemanticScholarClient.use((client) => client.references({ id: params.id, max: params.max })).pipe(
    Effect.mapError((error): RefsError => new RefsSemanticScholarError({ error })),
    Effect.map((result) => params.json ? JSON.stringify(result, undefined, 2) : renderReferences(result.warnings, result.data))
  )

const renderReferences = (warnings: ReadonlyArray<string>, references: ReadonlyArray<S2Reference>): string => {
  const lines: Array<string> = [...warnings]
  if (warnings.length > 0 && references.length > 0) lines.push("")
  for (const reference of references) lines.push(renderReference(reference))
  return lines.join("\n")
}

const renderReference = (reference: S2Reference): string => {
  const authors = reference.authors
    .map((name) => name.split(" ").filter((part) => part !== "").at(-1))
    .filter((name) => name !== undefined)
    .slice(0, 5)
    .join(", ")
    .slice(0, 60)
  const year = reference.year === undefined ? "" : ` (${reference.year})`
  return `  [${reference.id}]  ${reference.title}\n  ${authors}${year}\n`
}
