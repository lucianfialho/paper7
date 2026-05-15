import { Console, Effect } from "effect"
import type { CliCommand } from "../parser.js"

const DEPRECATION_MESSAGE = [
  "paper7 repo is deprecated.",
  "",
  "The Papers With Code API has been discontinued (the domain now redirects to",
  "huggingface.co/papers). Hugging Face acquired the brand but did not republish",
  "the curated paper-to-code mapping, so paper7 has no drop-in source for",
  "automatic repository discovery.",
  "",
  "Most papers link their reference implementation in the abstract or first page.",
  "Read the paper directly with:",
  "  paper7 get <id> --abstract-only",
].join("\n")

export const runRepoCommand = (
  _command: Extract<CliCommand, { readonly tag: "repo" }>
): Effect.Effect<void> =>
  Console.log(DEPRECATION_MESSAGE)
