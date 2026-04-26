import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { rootCommand, VERSION } from "../src/cli.js"
import { makeRepositoryDiscoveryClient, RepositoryDiscoveryClient, type RepositoryDiscoveryClientShape } from "../src/repo.js"
import { makeSemanticScholarClient, SemanticScholarClient, type SemanticScholarClientShape } from "../src/semanticScholar.js"

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

const papersJson = JSON.stringify({ results: [{ id: "fixture-paper", title: "Fixture Repository Paper" }] })
const emptyPapersJson = JSON.stringify({ results: [] })
const reposJson = JSON.stringify({
  results: [{ url: "https://github.com/example/fixture-repo", name: "fixture-repo", is_official: true }]
})
const partialReposJson = JSON.stringify({
  results: [
    { name: "missing-url" },
    { url: "https://github.com/example/recovered-repo", name: "recovered-repo", is_official: false }
  ]
})
const badShapeJson = JSON.stringify({ items: [] })

const unusedSemanticScholar: SemanticScholarClientShape = {
  references: () => Effect.fail({ _tag: "SemanticScholarDecodeError", message: "unexpected references" }),
  tldr: () => Effect.succeed(undefined)
}

const unusedRepositoryDiscovery: RepositoryDiscoveryClientShape = {
  discover: () => Effect.fail({ _tag: "PapersWithCodeDecodeError", message: "unexpected repo discovery" })
}

const runRootWith = (
  args: ReadonlyArray<string>,
  services: {
    readonly semanticScholar?: SemanticScholarClientShape
    readonly repositoryDiscovery?: RepositoryDiscoveryClientShape
  }
) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const program = Command.runWith(rootCommand, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(SemanticScholarClient, services.semanticScholar ?? unusedSemanticScholar),
      Effect.provideService(RepositoryDiscoveryClient, services.repositoryDiscovery ?? unusedRepositoryDiscovery)
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
      const repo = yield* runRootWith(["repo"], {})

      expect(refs.exit._tag).toBe("Failure")
      expect(`${refs.stdout}\n${refs.stderr}`).toContain("id")
      expect(repo.exit._tag).toBe("Failure")
      expect(`${repo.stdout}\n${repo.stderr}`).toContain("id")
    }))

  it.effect("surfaces Semantic Scholar missing, timeout, retry, and rate-limit paths", () =>
    Effect.gen(function*() {
      let retryCalls = 0
      const missing = yield* runRootWith(["refs", "9999.99999"], {
        semanticScholar: { references: () => Effect.fail({ _tag: "SemanticScholarNotFoundError", message: "no paper found on Semantic Scholar" }), tldr: unusedSemanticScholar.tldr }
      })
      const rate = yield* runRootWith(["refs", "1706.03762"], {
        semanticScholar: { references: () => Effect.fail({ _tag: "SemanticScholarRateLimitError", message: "Semantic Scholar rate limit exceeded", retryAfter: "30" }), tldr: unusedSemanticScholar.tldr }
      })
      const timeout = yield* runRootWith(["refs", "1706.03762"], {
        semanticScholar: { references: () => Effect.fail({ _tag: "SemanticScholarTimeoutError", message: "Semantic Scholar request timed out after 5ms" }), tldr: unusedSemanticScholar.tldr }
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

describe("repo command", () => {
  it.effect("routes typed ids through repository discovery and renders candidates", () =>
    Effect.gen(function*() {
      let captured = ""
      const result = yield* runRootWith(["repo", "doi:10.1000/example"], {
        repositoryDiscovery: {
          discover: (id) => Effect.sync(() => { captured = `${id.tag}:${id.id}` }).pipe(
            Effect.andThen(makeRepositoryDiscoveryClient({ fetchImpl: async (url) => new Response(url.includes("/repositories/") ? reposJson : papersJson), retries: 0 }).discover(id))
          )
        }
      })

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(captured).toBe("doi:10.1000/example")
      expect(result.stdout).toContain("Found 1 repository candidate:")
      expect(result.stdout).toContain("[papers-with-code official] fixture-repo")
      expect(result.stdout).toContain("https://github.com/example/fixture-repo")
    }))

  it.effect("labels missing repositories, partial failures, and decode errors", () =>
    Effect.gen(function*() {
      const missing = yield* runRootWith(["repo", "1706.03762"], {
        repositoryDiscovery: makeRepositoryDiscoveryClient({ fetchImpl: async () => new Response(emptyPapersJson), retries: 0 })
      })
      const partial = yield* runRootWith(["repo", "1706.03762"], {
        repositoryDiscovery: makeRepositoryDiscoveryClient({ fetchImpl: async (url) => new Response(url.includes("/repositories/") ? partialReposJson : papersJson), retries: 0 })
      })
      const decode = yield* runRootWith(["repo", "1706.03762"], {
        repositoryDiscovery: makeRepositoryDiscoveryClient({ fetchImpl: async () => new Response(badShapeJson), retries: 0 })
      })

      expect(missing.exit._tag).toBe("Success")
      expect(missing.stdout).toBe("No repositories found")
      expect(partial.exit._tag).toBe("Success")
      expect(partial.stdout).toContain("Papers With Code partial failure: skipped malformed repository")
      expect(partial.stdout).toContain("https://github.com/example/recovered-repo")
      expect(decode.exit._tag).toBe("Failure")
      expect(decode.stderr).toBe("error: Papers With Code decode failure: Papers With Code paper response missing results")
    }))

  it.effect("surfaces repository timeout, retry, transient, and rate-limit paths", () =>
    Effect.gen(function*() {
      let retryCalls = 0
      let transientCalls = 0
      const timeout = yield* runRootWith(["repo", "1706.03762"], {
        repositoryDiscovery: { discover: () => Effect.fail({ _tag: "PapersWithCodeTimeoutError", message: "Papers With Code request timed out after 5ms" }) }
      })
      const rate = yield* runRootWith(["repo", "1706.03762"], {
        repositoryDiscovery: makeRepositoryDiscoveryClient({ fetchImpl: async () => new Response("limited", { status: 429, headers: { "retry-after": "60" } }), retries: 1, retryDelay: 0 })
      })
      const retryClient = makeRepositoryDiscoveryClient({
        fetchImpl: async (url) => {
          retryCalls += 1
          if (retryCalls === 1) return new Response("busy", { status: 500 })
          return new Response(url.includes("/repositories/") ? JSON.stringify({ results: [] }) : papersJson)
        },
        retries: 1,
        retryDelay: 0
      })
      const transientClient = makeRepositoryDiscoveryClient({
        fetchImpl: async () => {
          transientCalls += 1
          return new Response("busy", { status: 500 })
        },
        retries: 1,
        retryDelay: 0
      })
      const retried = yield* retryClient.discover({ tag: "arxiv", id: "1706.03762" })
      const transient = yield* Effect.result(transientClient.discover({ tag: "pubmed", id: "38903003" }))

      expect(timeout.exit._tag).toBe("Failure")
      expect(timeout.stderr).toBe("error: Papers With Code upstream failure: Papers With Code request timed out after 5ms")
      expect(rate.exit._tag).toBe("Failure")
      expect(rate.stderr).toBe("error: Papers With Code rate limit exceeded; retry after 60")
      expect(retryCalls).toBe(3)
      expect(retried).toEqual({ candidates: [], warnings: [] })
      expect(transient._tag).toBe("Failure")
      expect(transientCalls).toBe(2)
    }))
})
