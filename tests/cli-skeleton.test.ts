import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect, Stdio } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { CommandLoadError, makeRootCommand, rootCommand, VERSION } from "../src/cli.js"

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

  it.effect("prints help for short help flag and no args", () =>
    Effect.gen(function*() {
      const short = yield* runRootWith(["-h"])
      const empty = yield* runRootWith([])

      expect(short.stderr).toBe("")
      expect(empty.stderr).toBe("")
      expect(short.stdout).toContain("USAGE")
      expect(empty.stdout).toContain("USAGE")
      expect(short.stdout).toContain("SUBCOMMANDS")
      expect(empty.stdout).toContain("SUBCOMMANDS")
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

const runWithLoader = (
  args: ReadonlyArray<string>,
  loaders: Partial<import("../src/cli.js").CommandLoaders>
) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const cmd = makeRootCommand(loaders)
    const program = Command.runWith(cmd, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole)
    )
    const exit = yield* Effect.result(program)
    const logs = yield* testConsole.logLines
    const errors = yield* testConsole.errorLines
    return {
      exit,
      stdout: logs.map(String).join("\n"),
      stderr: errors.map(String).join("\n")
    }
  }).pipe(
    Effect.provide(deterministicCliOutput),
    Effect.provide(NodeServices.layer)
  )

describe("lazy-load get command", () => {
  it.effect("does not load get module for --version", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => { loads += 1; return { runGetCommand: () => Effect.succeed(undefined) } })
      const result = yield* runWithLoader(["--version"], { get: loader })
      expect(result.exit._tag).toBe("Success")
      expect(result.stdout).toBe(`paper7 v${VERSION}`)
      expect(loads).toBe(0)
    }))

  it.effect("does not load get module for --help", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => { loads += 1; return { runGetCommand: () => Effect.succeed(undefined) } })
      const result = yield* runWithLoader(["--help"], { get: loader })
      expect(result.exit._tag).toBe("Success")
      expect(result.stdout).toContain("USAGE")
      expect(loads).toBe(0)
    }))

  it.effect("loads get module once for get command", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => {
        loads += 1
        return {
          runGetCommand: () => Console.log("<untrusted-content source=\"test\" id=\"test\">\n# Test Paper\n</untrusted-content>")
        }
      })
      const result = yield* runWithLoader(["get", "2401.04088", "--no-cache", "--no-tldr"], { get: loader })
      expect(result.exit._tag).toBe("Success")
      expect(loads).toBe(1)
      expect(result.stdout).toContain("# Test Paper")
    }))

  it.effect("surfaces CommandLoadError with user-facing message", () =>
    Effect.gen(function*() {
      const loader = () => Effect.fail(new CommandLoadError({ command: "get", message: "module not found", cause: "test" }))
      const result = yield* runWithLoader(["get", "2401.04088"], { get: loader })
      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toContain("failed to load get command implementation")
      expect(result.stderr).toContain("module not found")
    }))
})

describe("lazy-load remaining commands", () => {
  it.effect("does not load search module for --version", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => { loads += 1; return { runSearchCommand: () => Effect.succeed(undefined) } })
      const result = yield* runWithLoader(["--version"], { search: loader })
      expect(result.exit._tag).toBe("Success")
      expect(result.stdout).toBe(`paper7 v${VERSION}`)
      expect(loads).toBe(0)
    }))

  it.effect("loads search module for search command", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => {
        loads += 1
        return {
          runSearchCommand: () => Effect.succeed(undefined)
        }
      })
      const result = yield* runWithLoader(["search", "test", "--no-cache"], { search: loader })
      expect(result.exit._tag).toBe("Success")
      expect(loads).toBe(1)
    }))

  it.effect("loads cache module for list command", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => {
        loads += 1
        return {
          runCacheCommand: () => Effect.succeed(undefined)
        }
      })
      const result = yield* runWithLoader(["list"], { cache: loader })
      expect(result.exit._tag).toBe("Success")
      expect(loads).toBe(1)
    }))

  it.effect("loads cache module for cache clear command", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => {
        loads += 1
        return {
          runCacheCommand: () => Effect.succeed(undefined)
        }
      })
      const result = yield* runWithLoader(["cache", "clear"], { cache: loader })
      expect(result.exit._tag).toBe("Success")
      expect(loads).toBe(1)
    }))

  it.effect("loads vault module for vault init command", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => {
        loads += 1
        return {
          runVaultCommand: () => Effect.succeed(undefined)
        }
      })
      const result = yield* runWithLoader(["vault", "init", "/tmp/vault"], { vault: loader })
      expect(result.exit._tag).toBe("Success")
      expect(loads).toBe(1)
    }))

  it.effect("loads refs module for refs command", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => {
        loads += 1
        return {
          runRefsCommand: () => Effect.succeed(undefined)
        }
      })
      const result = yield* runWithLoader(["refs", "2401.04088"], { refs: loader })
      expect(result.exit._tag).toBe("Success")
      expect(loads).toBe(1)
    }))

  it.effect("loads repo module for repo command", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => {
        loads += 1
        return {
          runRepoCommand: () => Effect.succeed(undefined)
        }
      })
      const result = yield* runWithLoader(["repo", "2401.04088"], { repo: loader })
      expect(result.exit._tag).toBe("Success")
      expect(loads).toBe(1)
    }))

  it.effect("loads browse module for browse command", () =>
    Effect.gen(function*() {
      let loads = 0
      const loader = () => Effect.sync(() => {
        loads += 1
        return {
          runBrowseCommand: () => Effect.succeed(undefined)
        }
      })
      const result = yield* runWithLoader(["browse"], { browse: loader })
      expect(result.exit._tag).toBe("Success")
      expect(loads).toBe(1)
    }))

  it.effect("surfaces CommandLoadError for search", () =>
    Effect.gen(function*() {
      const loader = () => Effect.fail(new CommandLoadError({ command: "search", message: "search module not found", cause: "test" }))
      const result = yield* runWithLoader(["search", "test", "--no-cache"], { search: loader })
      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toContain("failed to load search command implementation")
      expect(result.stderr).toContain("search module not found")
    }))
})
