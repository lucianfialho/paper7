import { Console, Effect } from "effect"
import { CachePaths } from "../cache.js"
import { exportAllPapersToVault, exportPaperToVault, initVault, type VaultError, type VaultInitResult, type VaultExportResult, type VaultExportAllResult, VaultPaths } from "../vault.js"
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
        return
      }
    }
  })

const renderVaultInit = (result: VaultInitResult): string => `Configured vault: ${result.path}`

const renderVaultExport = (result: VaultExportResult): string => `Exported ${result.id} to ${result.path}`

const renderVaultExportAll = (result: VaultExportAllResult): string => `Exported ${result.count} papers to ${result.path}`


