import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect, Stdio } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { rootCommand, VERSION } from "../src/cli.js"

const deterministicCliOutput = CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))

const runRootWith = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    yield* Command.runWith(rootCommand, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole)
    )
    const logs = yield* testConsole.logLines
    const errors = yield* testConsole.errorLines
    return {
      stdout: logs.map(String).join("\n"),
      stderr: errors.map(String).join("\n")
    }
  }).pipe(
    Effect.provide(deterministicCliOutput),
    Effect.provide(NodeServices.layer)
  )

const runRootFromStdio = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    yield* Command.run(rootCommand, { version: VERSION }).pipe(
      Effect.provideService(Console.Console, testConsole)
    )
    const logs = yield* testConsole.logLines
    return logs.map(String).join("\n")
  }).pipe(
    Effect.provide(deterministicCliOutput),
    Effect.provide(Stdio.layerTest({ args: Effect.succeed(args) })),
    Effect.provide(NodeServices.layer)
  )

describe("Effect CLI skeleton", () => {
  it.effect("prints help through Command.runWith", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["--help"])

      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("USAGE")
      expect(result.stdout).toContain("paper7")
      expect(result.stdout).toContain("SUBCOMMANDS")
      expect(result.stdout).toContain("search")
      expect(result.stdout).toContain("GLOBAL FLAGS")
      expect(result.stdout).toContain("--version")
    }))

  it.effect("routes help subcommand to root help", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["help"])

      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("USAGE")
      expect(result.stdout).toContain("paper7")
      expect(result.stdout).toContain("SUBCOMMANDS")
    }))

  it.effect("prints version through built-in and alias flags", () =>
    Effect.gen(function*() {
      const long = yield* runRootWith(["--version"])
      const short = yield* runRootWith(["-v"])

      expect(long.stdout).toBe(`paper7 v${VERSION}`)
      expect(short.stdout).toBe(`paper7 v${VERSION}`)
    }))

  it.effect("boots from Effect Stdio args", () =>
    Effect.gen(function*() {
      const output = yield* runRootFromStdio(["--version"])

      expect(output).toBe(`paper7 v${VERSION}`)
    }))
})
