import { Console, Effect } from "effect"
import { RepositoryDiscoveryClient, type RepositoryDiscoveryError, type RepositoryDiscoveryResult } from "../repo.js"
import type { CliCommand } from "../parser.js"

export const runRepoCommand = (
  command: Extract<CliCommand, { readonly tag: "repo" }>
): Effect.Effect<void, RepositoryDiscoveryError, RepositoryDiscoveryClient> =>
  RepositoryDiscoveryClient.use((client) => client.discover(command.id)).pipe(
    Effect.flatMap((result) => Console.log(renderRepositoryDiscovery(result)))
  )

const renderRepositoryDiscovery = (result: RepositoryDiscoveryResult): string => {
  const lines: Array<string> = [...result.warnings]
  if (result.candidates.length === 0) {
    if (lines.length > 0) lines.push("")
    lines.push("No repositories found")
    return lines.join("\n")
  }

  if (lines.length > 0) lines.push("")
  lines.push(`Found ${result.candidates.length} repository candidate${result.candidates.length === 1 ? "" : "s"}:`)
  for (const candidate of result.candidates) {
    const official = candidate.isOfficial === true ? " official" : ""
    const name = candidate.name === undefined ? "" : ` ${candidate.name}`
    lines.push(`  [${candidate.source}${official}]${name}`)
    lines.push(`  ${candidate.url}`)
    lines.push("")
  }
  return lines.join("\n")
}


