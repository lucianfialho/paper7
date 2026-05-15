import { Console, Effect } from "effect"
import { CachePaths } from "../cache.js"
import { exportAllPapersToVault, exportPaperToVault, initVault, type VaultError, VaultExportAllFailed, type VaultInitResult, type VaultExportResult, type VaultExportAllResult, VaultPaths } from "../vault.js"
import type { CliCommand } from "../parser.js"

export const runVaultCommand = (
  command: Extract<CliCommand, { readonly tag: "vault-init" | "vault-export" | "vault-all" }>
): Effect.Effect<void, VaultError, VaultPaths | CachePaths> =>
  Effect.gen(function*() {
    switch (command.tag) {
      case "vault-init": {
        const result = yield* initVault(command.path)
        yield* Console.log(renderVaultInit(result))
        return
      }
      case "vault-export": {
        const result = yield* exportPaperToVault(command.id)
        yield* Console.log(renderVaultExport(result))
        return
      }
      case "vault-all": {
        const result = yield* exportAllPapersToVault()
        yield* Console.log(renderVaultExportAll(result))
        if (result.exported.length === 0 && result.total > 0) {
          return yield* Effect.fail(new VaultExportAllFailed({ message: "all cache entries failed to export" }))
        }
        return
      }
    }
  })

const renderVaultInit = (result: VaultInitResult): string => `Configured vault: ${result.path}`

const renderVaultExport = (result: VaultExportResult): string => `Exported ${result.id} to ${result.path}`

const renderVaultExportAll = (result: VaultExportAllResult): string => {
  const header = `Exported ${result.exported.length} of ${result.total} papers to ${result.path}`
  if (result.failed.length === 0) return header
  return [
    header,
    "Skipped:",
    ...result.failed.map((entry) => `  ${entry.id} — ${entry.reason}`),
  ].join("\n")
}


