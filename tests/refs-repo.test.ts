import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { rootCommand, VERSION } from "../src/cli.js"
import { getReferences, RefsSemanticScholarError } from "../src/refs.js"
import { makeSemanticScholarClient, SemanticScholarClient, SemanticScholarDecodeError, SemanticScholarNotFoundError, SemanticScholarRateLimitError, SemanticScholarTimeoutError, type SemanticScholarClientShape } from "../src/semanticScholar.js"

const deterministicCliOutput = CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))

const refsJson = JSON.stringify({
  data: [{
    citedPaper: {
      paperId: "abc123",
      externalIds: { ArXiv: "1706.03762" },
      title: "Attention Is All You Need",
      authors: [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }],
      year: 2017
    }
  }]
})

const partialRefsJson = JSON.stringify({
  data: [
    { bad: true },
    {
      citedPaper: {
        paperId: "def456",
        externalIds: { DOI: "10.1000/test" },
        title: "Enriched Reference",
        authors: [{ name: "Grace Hopper" }],
        year: 1952
      }
    }
  ]
})

const unusedSemanticScholar: SemanticScholarClientShape = {
  references: () => Effect.fail(new SemanticScholarDecodeError({ message: "unexpected references" })),
  tldr: () => Effect.succeed(undefined)
}

const runRootWith = (
  args: ReadonlyArray<string>,
  services: {
    readonly semanticScholar?: SemanticScholarClientShape
  }
) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const program = Command.runWith(rootCommand, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(SemanticScholarClient, services.semanticScholar ?? unusedSemanticScholar)
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

describe("refs command", () => {
  it.effect("routes typed ids through Semantic Scholar and renders references", () =>
    Effect.gen(function*() {
      let captured = ""
      const result = yield* runRootWith(["refs", "https://arxiv.org/abs/1706.03762v7", "--max", "1"], {
        semanticScholar: {
          references: (params) => Effect.sync(() => { captured = `${params.id.tag}:${params.id.id}:${params.max}` }).pipe(
            Effect.andThen(makeSemanticScholarClient({ fetchImpl: async () => new Response(refsJson), retries: 0 }).references(params))
          ),
          tldr: unusedSemanticScholar.tldr
        }
      })

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(captured).toBe("arxiv:1706.03762:1")
      expect(result.stdout).toContain("[arxiv:1706.03762]  Attention Is All You Need")
      expect(result.stdout).toContain("Vaswani, Shazeer (2017)")
    }))

  it.effect("emits raw valid JSON for refs --json", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["refs", "1706.03762", "--max", "1", "--json"], {
        semanticScholar: {
          references: (params) => makeSemanticScholarClient({ fetchImpl: async () => new Response(refsJson), retries: 0 }).references(params),
          tldr: unusedSemanticScholar.tldr
        }
      })
      const parsed: unknown = JSON.parse(result.stdout)

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(parsed).toEqual({
        data: [{ id: "arxiv:1706.03762", title: "Attention Is All You Need", authors: ["Ashish Vaswani", "Noam Shazeer"], year: 2017 }],
        warnings: []
      })
    }))

  it.effect("labels partial failures and rejects invalid flags deterministically", () =>
    Effect.gen(function*() {
      const partial = yield* runRootWith(["refs", "1706.03762", "--max", "2"], {
        semanticScholar: {
          references: (params) => makeSemanticScholarClient({ fetchImpl: async () => new Response(partialRefsJson), retries: 0 }).references(params),
          tldr: unusedSemanticScholar.tldr
        }
      })
      const invalidMax = yield* runRootWith(["refs", "1706.03762", "--max", "0"], {})
      const invalidFlag = yield* runRootWith(["refs", "1706.03762", "--yaml"], {})

      expect(partial.exit._tag).toBe("Success")
      expect(partial.stdout).toContain("Semantic Scholar partial failure: skipped malformed reference")
      expect(partial.stdout).toContain("[doi:10.1000/test]  Enriched Reference")
      expect(invalidMax.exit._tag).toBe("Failure")
      expect(`${invalidMax.stdout}\n${invalidMax.stderr}`).toContain("--max requires a positive integer")
      expect(invalidFlag.exit._tag).toBe("Failure")
      expect(`${invalidFlag.stdout}\n${invalidFlag.stderr}`).toContain("yaml")
    }))

  it.effect("rejects missing ids before invoking services", () =>
    Effect.gen(function*() {
      const refs = yield* runRootWith(["refs"], {})

      expect(refs.exit._tag).toBe("Failure")
      expect(`${refs.stdout}\n${refs.stderr}`).toContain("id")
    }))

  it.effect("surfaces Semantic Scholar missing, timeout, retry, and rate-limit paths", () =>
    Effect.gen(function*() {
      let retryCalls = 0
      const missing = yield* runRootWith(["refs", "9999.99999"], {
        semanticScholar: { references: () => Effect.fail(new SemanticScholarNotFoundError({ message: "no paper found on Semantic Scholar" })), tldr: unusedSemanticScholar.tldr }
      })
      const rate = yield* runRootWith(["refs", "1706.03762"], {
        semanticScholar: { references: () => Effect.fail(new SemanticScholarRateLimitError({ message: "Semantic Scholar rate limit exceeded", retryAfter: "30" })), tldr: unusedSemanticScholar.tldr }
      })
      const timeout = yield* runRootWith(["refs", "1706.03762"], {
        semanticScholar: { references: () => Effect.fail(new SemanticScholarTimeoutError({ message: "Semantic Scholar request timed out after 5ms" })), tldr: unusedSemanticScholar.tldr }
      })
      const retryClient = makeSemanticScholarClient({
        fetchImpl: async () => {
          retryCalls += 1
          return retryCalls === 1 ? new Response("busy", { status: 500 }) : new Response(JSON.stringify({ data: [] }))
        },
        retries: 1,
        retryDelay: 0
      })
      const retried = yield* retryClient.references({ id: { tag: "arxiv", id: "1706.03762" }, max: 1 })

      expect(missing.exit._tag).toBe("Failure")
      expect(missing.stderr).toBe("error: no paper found on Semantic Scholar")
      expect(rate.exit._tag).toBe("Failure")
      expect(rate.stderr).toBe("error: Semantic Scholar rate limit exceeded; retry after 30")
      expect(timeout.exit._tag).toBe("Failure")
      expect(timeout.stderr).toBe("error: Semantic Scholar upstream failure: Semantic Scholar request timed out after 5ms")
      expect(retryCalls).toBe(2)
      expect(retried).toEqual({ data: [], warnings: [] })
    }))
})

describe("repo command (deprecated)", () => {
  it.effect("prints a deprecation notice and exits 0 with no id (issue #21)", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["repo"], {})

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("paper7 repo is deprecated")
      expect(result.stdout).toContain("Papers With Code API has been discontinued")
      expect(result.stdout).toContain("paper7 get <id> --abstract-only")
    }))

  it.effect("ignores the id argument and still prints the deprecation notice (issue #21)", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["repo", "2210.03629"], {})

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("paper7 repo is deprecated")
    }))
})

describe("yieldable refs errors", () => {
  it.effect("refs wrapper yields RefsSemanticScholarError with nested SemanticScholarError", () =>
    Effect.gen(function*() {
      const fakeClient: SemanticScholarClientShape = {
        references: () => Effect.fail(new SemanticScholarRateLimitError({ message: "rate limited", retryAfter: "10" })),
        tldr: () => Effect.succeed(undefined)
      }
      const result = yield* getReferences({ id: { tag: "arxiv", id: "1706.03762" }, max: 1, json: false }).pipe(
        Effect.provideService(SemanticScholarClient, fakeClient),
        Effect.flip
      )

      expect(result._tag).toBe("RefsSemanticScholarError")
      expect(result.error._tag).toBe("SemanticScholarRateLimitError")
      expect(result.error.retryAfter).toBe("10")
    }))
})
