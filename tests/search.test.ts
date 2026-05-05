import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArxivClient, ArxivDecodeError, ArxivTimeoutError, ArxivTransientError, decodeArxivFeed, makeArxivClient, type ArxivClientShape } from "../src/arxiv.js"
import { CachePaths } from "../src/cache.js"
import { rootCommand, VERSION } from "../src/cli.js"
import { normalizeSearchQuery, SEARCH_CACHE_TTL_MS } from "../src/searchCache.js"
import { PubmedClient, PubmedDecodeError, PubmedHttpError, PubmedTransientError, decodeSearchResponse, makePubmedClient, type PubmedClientShape } from "../src/pubmed.js"

const deterministicCliOutput = CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))

const arxivSearchXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>42</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2401.04088v2</id>
    <published>2024-01-08T18:59:59Z</published>
    <title>Test &amp; Search Paper</title>
    <author><name>Ada Lovelace</name></author>
    <author><name>Grace Hopper</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/not-an-id</id>
    <published>2024-01-09T00:00:00Z</published>
    <title>Malformed entry</title>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2312.00001v1</id>
    <published>2023-12-01T10:30:00Z</published>
    <title>Another Result</title>
    <author><name>Katherine Johnson</name></author>
  </entry>
</feed>`

const arxivBadShapeXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.04088v1</id>
    <published>2024-01-08T18:59:59Z</published>
    <title>Missing total</title>
  </entry>
</feed>`

const pubmedSearchJson = JSON.stringify({
  esearchresult: {
    count: "42",
    idlist: ["38903003", "38600001"]
  }
})

const pubmedSummaryJson = JSON.stringify({
  result: {
    uids: ["38903003", "38600001"],
    "38903003": {
      uid: "38903003",
      title: "Test PubMed Search Paper",
      pubdate: "2024 Jun 18",
      authors: [{ name: "Ada Lovelace" }, { name: "Grace Hopper" }]
    },
    "38600001": {
      uid: "38600001",
      title: "Another PubMed Result",
      pubdate: "2023 Dec",
      authors: [{ name: "Katherine Johnson" }]
    }
  }
})

const pubmedBadSearchJson = JSON.stringify({
  esearchresult: {
    idlist: ["38903003"]
  }
})

const pubmedSummaryWithWarningJson = JSON.stringify({
  result: {
    uids: ["38903003", "38600001"],
    "38903003": {
      uid: "38903003",
      title: "Test PubMed Search Paper",
      pubdate: "2024 Jun 18",
      authors: [{ name: "Ada Lovelace" }]
    },
    "38600001": {
      uid: "38600001",
      pubdate: "2023 Dec",
      authors: [{ name: "Katherine Johnson" }]
    }
  }
})

const unexpectedArxivGet = new ArxivDecodeError({ message: "unexpected get" })
const unexpectedPubmedGet = new PubmedDecodeError({ message: "unexpected get" })

const failingArxivGet = () => Effect.fail(unexpectedArxivGet)
const failingPubmedGet = () => Effect.fail(unexpectedPubmedGet)

const arxivFixtureClient: ArxivClientShape = {
  search: () => decodeArxivFeed(arxivSearchXml),
  get: failingArxivGet
}

const pubmedFixtureClient = makePubmedClient({
  fetchImpl: async (url) =>
    new Response(url.includes("esearch.fcgi") ? pubmedSearchJson : pubmedSummaryJson, { status: 200 }),
  timeoutMs: 1_000,
  retries: 0
})

const unusedPubmedClient: PubmedClientShape = {
  search: () => Effect.fail(new PubmedDecodeError({ message: "unexpected search" })),
  get: failingPubmedGet
}

const unusedArxivClient: ArxivClientShape = {
  search: () => Effect.fail(new ArxivDecodeError({ message: "unexpected search" })),
  get: failingArxivGet
}

const runRootWith = (
  args: ReadonlyArray<string>,
  clients: {
    readonly arxiv: ArxivClientShape
    readonly pubmed: PubmedClientShape
  },
  cacheRoot?: string
) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const program = Command.runWith(rootCommand, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(ArxivClient, clients.arxiv),
      Effect.provideService(PubmedClient, clients.pubmed),
      Effect.provideService(CachePaths, { cacheRoot: cacheRoot ?? "/tmp/paper7-test-cache" })
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

describe("search command", () => {
  it.effect("routes default arXiv search through fake client and renders fixture results", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["search", "attention", "--max", "2"], {
        arxiv: arxivFixtureClient,
        pubmed: unusedPubmedClient
      })

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Found 42 papers (showing 2):")
      expect(result.stdout).toContain("arXiv partial failure: skipped malformed result")
      expect(result.stdout).toContain("[2401.04088] Test & Search Paper")
      expect(result.stdout).toContain("Ada Lovelace, Grace Hopper (2024-01-08)")
      expect(result.stdout).toContain("[2312.00001] Another Result")
    }))

  it.effect("routes PubMed search through fake client and renders fixture results", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["search", "covid", "--source", "pubmed", "--max", "2"], {
        arxiv: unusedArxivClient,
        pubmed: pubmedFixtureClient
      })

      expect(result.exit._tag).toBe("Success")
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Found 42 papers (showing 2):")
      expect(result.stdout).toContain("[pmid:38903003] Test PubMed Search Paper")
      expect(result.stdout).toContain("Ada Lovelace, Grace Hopper (2024)")
      expect(result.stdout).toContain("[pmid:38600001] Another PubMed Result")
    }))

  it.effect("surfaces arXiv decode failures deterministically", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["search", "attention"], {
        arxiv: { search: () => decodeArxivFeed(arxivBadShapeXml), get: failingArxivGet },
        pubmed: unusedPubmedClient
      })

      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toBe("error: arXiv decode failure: arXiv response missing totalResults")
    }))

  it.effect("formatted arXiv decode failures remain catchable by domain tag", () =>
    Effect.gen(function*() {
      const program = Command.runWith(rootCommand, { version: VERSION })(["search", "attention"]).pipe(
        Effect.provideService(ArxivClient, {
          search: () => Effect.fail(new ArxivDecodeError({ message: "arXiv response missing totalResults" })),
          get: failingArxivGet
        }),
        Effect.provideService(PubmedClient, unusedPubmedClient),
        Effect.provideService(CachePaths, { cacheRoot: "/tmp/paper7-test-cache" })
      )

      const recovered = yield* program.pipe(
        Effect.catchTag("ArxivDecodeError", (error) => Effect.succeed(error.message))
      )

      expect(recovered).toBe("arXiv response missing totalResults")
    }).pipe(
      Effect.provide(deterministicCliOutput),
      Effect.provide(NodeServices.layer)
    ))

  it.effect("surfaces PubMed decode failures deterministically", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["search", "covid", "--source", "pubmed"], {
        arxiv: unusedArxivClient,
        pubmed: {
          search: () => decodeSearchResponse(pubmedBadSearchJson).pipe(
            Effect.flatMap(() => Effect.succeed({ total: 0, papers: [], warnings: [] }))
          ),
          get: failingPubmedGet
        }
      })

      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toBe("error: PubMed decode failure: PubMed search response missing count or idlist")
    }))

  it.effect("surfaces arXiv upstream failures deterministically", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["search", "attention"], {
        arxiv: {
          search: () => Effect.fail(new ArxivTransientError({ message: "arXiv transient HTTP 500", cause: 500 })),
          get: failingArxivGet
        },
        pubmed: unusedPubmedClient
      })

      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toBe("error: arXiv upstream failure: arXiv transient HTTP 500")
    }))

  it.effect("surfaces PubMed upstream failures deterministically", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["search", "covid", "--source", "pubmed"], {
        arxiv: unusedArxivClient,
        pubmed: {
          search: () => Effect.fail(new PubmedHttpError({ status: 503, message: "PubMed HTTP 503" })),
          get: failingPubmedGet
        }
      })

      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toBe("error: PubMed upstream failure: PubMed HTTP 503")
    }))

  it.effect("surfaces arXiv timeout failures from yieldable fake client", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["search", "attention"], {
        arxiv: {
          search: () => Effect.gen(function*() {
            yield* new ArxivTimeoutError({ message: "arXiv request timed out after 100ms" })
          }),
          get: failingArxivGet
        },
        pubmed: unusedPubmedClient
      })

      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toBe("error: arXiv upstream failure: arXiv request timed out after 100ms")
    }))

  it.effect("surfaces PubMed transient failures from yieldable fake client", () =>
    Effect.gen(function*() {
      const result = yield* runRootWith(["search", "covid", "--source", "pubmed"], {
        arxiv: unusedArxivClient,
        pubmed: {
          search: () => Effect.gen(function*() {
            yield* new PubmedTransientError({ message: "PubMed transient HTTP 500", cause: 500 })
          }),
          get: failingPubmedGet
        }
      })

      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toBe("error: PubMed upstream failure: PubMed transient HTTP 500")
    }))

  it.effect("rejects invalid search options through Effect CLI validation", () =>
    Effect.gen(function*() {
      const badSource = yield* runRootWith(["search", "attention", "--source", "crossref"], {
        arxiv: unusedArxivClient,
        pubmed: unusedPubmedClient
      })
      const badSort = yield* runRootWith(["search", "attention", "--sort", "oldest"], {
        arxiv: unusedArxivClient,
        pubmed: unusedPubmedClient
      })
      const badMax = yield* runRootWith(["search", "attention", "--max", "0"], {
        arxiv: unusedArxivClient,
        pubmed: unusedPubmedClient
      })

      expect(badSource.exit._tag).toBe("Failure")
      expect(badSource.stderr).toContain("crossref")
      expect(badSort.exit._tag).toBe("Failure")
      expect(badSort.stderr).toContain("oldest")
      expect(badMax.exit._tag).toBe("Failure")
      expect(badMax.stderr).toContain("--max requires a positive integer")
    }))
})

describe("search source clients", () => {
  it.effect("maps arXiv max, sort, and query to API URL", () =>
    Effect.gen(function*() {
      let captured = ""
      const client = makeArxivClient({
        fetchImpl: async (url) => {
          captured = url
          return new Response(`<?xml version="1.0"?><feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults></feed>`, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      yield* client.search({ query: "graph neural", max: 7, sort: "date" })

      expect(captured).toContain("max_results=7")
      expect(captured).toContain("sortBy=submittedDate")
      expect(captured).toContain("search_query=all%3Agraph+neural")
    }))

  it.effect("maps arXiv non-retryable HTTP errors to ArxivHttpError", () =>
    Effect.gen(function*() {
      const client = makeArxivClient({
        fetchImpl: async () => new Response("bad request", { status: 400 }),
        timeoutMs: 1_000,
        retries: 0
      })

      const error = yield* client.search({ query: "test", max: 1, sort: "relevance" }).pipe(Effect.flip)
      expect(error._tag).toBe("ArxivHttpError")
      expect(error.message).toBe("arXiv HTTP 400")
      expect(error.status).toBe(400)
    }))

  it.effect("maps arXiv retryable HTTP errors to ArxivTransientError", () =>
    Effect.gen(function*() {
      const client = makeArxivClient({
        fetchImpl: async () => new Response("server error", { status: 500 }),
        timeoutMs: 1_000,
        retries: 0
      })

      const error = yield* client.search({ query: "test", max: 1, sort: "relevance" }).pipe(Effect.flip)
      expect(error._tag).toBe("ArxivTransientError")
      expect(error.message).toBe("arXiv transient HTTP 500")
    }))

  it.effect("maps PubMed max, sort, query, and summary ids to API URLs", () =>
    Effect.gen(function*() {
      const captured: Array<string> = []
      const client = makePubmedClient({
        fetchImpl: async (url) => {
          captured.push(url)
          return new Response(captured.length === 1 ? pubmedSearchJson : pubmedSummaryJson, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      yield* client.search({ query: "heart failure", max: 7, sort: "date" })

      expect(captured.join("\n")).toContain("retmax=7")
      expect(captured.join("\n")).toContain("sort=pub+date")
      expect(captured.join("\n")).toContain("term=heart+failure")
      expect(captured.join("\n")).toContain("id=38903003%2C38600001")
    }))

  it.effect("maps PubMed non-retryable HTTP errors to PubmedHttpError", () =>
    Effect.gen(function*() {
      const client = makePubmedClient({
        fetchImpl: async () => new Response("bad request", { status: 400 }),
        timeoutMs: 1_000,
        retries: 0
      })

      const error = yield* client.search({ query: "test", max: 1, sort: "relevance" }).pipe(Effect.flip)
      expect(error._tag).toBe("PubmedHttpError")
      expect(error.message).toBe("PubMed HTTP 400")
      expect(error.status).toBe(400)
    }))

  it.effect("maps PubMed retryable HTTP errors to PubmedTransientError", () =>
    Effect.gen(function*() {
      const client = makePubmedClient({
        fetchImpl: async () => new Response("server error", { status: 500 }),
        timeoutMs: 1_000,
        retries: 0
      })

      const error = yield* client.search({ query: "test", max: 1, sort: "relevance" }).pipe(Effect.flip)
      expect(error._tag).toBe("PubmedTransientError")
      expect(error.message).toBe("PubMed transient HTTP 500")
    }))
})

const withTempCache = <A, E, R>(effect: (cacheRoot: string) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "paper7-search-cache-"))),
    (root) => effect(join(root, "cache")),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
  )

describe("search cache", () => {
  it.effect("first search misses cache, calls client, and writes cache envelope", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = { search: () => { calls += 1; return decodeArxivFeed(arxivSearchXml) }, get: failingArxivGet }

      const result = yield* runRootWith(["search", "attention", "--max", "2"], {
        arxiv: client,
        pubmed: unusedPubmedClient
      }, cacheRoot)

      expect(result.exit._tag).toBe("Success")
      expect(calls).toBe(1)

      const files = yield* Effect.promise(() => readdir(join(cacheRoot, "search", "arxiv")).catch(() => []))
      expect(files.length).toBeGreaterThan(0)
    })))

  it.effect("second equivalent search hits cache and does not call client", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = { search: () => { calls += 1; return decodeArxivFeed(arxivSearchXml) }, get: failingArxivGet }

      const first = yield* runRootWith(["search", "attention", "--max", "2"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(first.exit._tag).toBe("Success")
      expect(calls).toBe(1)

      const second = yield* runRootWith(["search", "attention", "--max", "2"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(second.exit._tag).toBe("Success")
      expect(calls).toBe(1)
      expect(second.stdout).toContain("Found 42 papers (showing 2):")
    })))

  it.effect("equivalent query with different whitespace and case hits cache", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = { search: () => { calls += 1; return decodeArxivFeed(arxivSearchXml) }, get: failingArxivGet }

      yield* runRootWith(["search", "Attention  Mechanism", "--max", "2"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(1)

      yield* runRootWith(["search", "  attention mechanism  ", "--max", "2"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(1)
    })))

  it.effect("different max value misses cache and calls client again", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = { search: () => { calls += 1; return decodeArxivFeed(arxivSearchXml) }, get: failingArxivGet }

      yield* runRootWith(["search", "attention", "--max", "2"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(1)

      yield* runRootWith(["search", "attention", "--max", "5"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(2)
    })))

  it.effect("different sort value misses cache and calls client again", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = { search: () => { calls += 1; return decodeArxivFeed(arxivSearchXml) }, get: failingArxivGet }

      yield* runRootWith(["search", "attention", "--sort", "relevance"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(1)

      yield* runRootWith(["search", "attention", "--sort", "date"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(2)
    })))

  it.effect("stale cache is ignored and overwritten after successful fresh search", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = { search: () => { calls += 1; return decodeArxivFeed(arxivSearchXml) }, get: failingArxivGet }

      yield* runRootWith(["search", "attention"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(1)

      yield* TestClock.adjust(SEARCH_CACHE_TTL_MS + 1)

      yield* runRootWith(["search", "attention"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(2)
    })))

  it.effect("failed arXiv search does not create cache file", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      const client = {
        search: () => Effect.fail(new ArxivTransientError({ message: "arXiv transient HTTP 500", cause: 500 })),
        get: failingArxivGet
      }

      const result = yield* runRootWith(["search", "attention"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(result.exit._tag).toBe("Failure")

      const searchDir = join(cacheRoot, "search", "arxiv")
      const exists = yield* Effect.promise(() => readFile(searchDir).then(() => true, () => false))
      expect(exists).toBe(false)
    })))

  it.effect("cached result preserves decode warnings in rendered output", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      const client = { search: () => decodeArxivFeed(arxivSearchXml), get: failingArxivGet }

      const first = yield* runRootWith(["search", "attention", "--max", "2"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(first.stdout).toContain("arXiv partial failure: skipped malformed result")

      const second = yield* runRootWith(["search", "attention", "--max", "2"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(second.stdout).toContain("arXiv partial failure: skipped malformed result")
    })))

  it.effect("search --no-cache bypasses cache read and write", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = { search: () => { calls += 1; return decodeArxivFeed(arxivSearchXml) }, get: failingArxivGet }

      yield* runRootWith(["search", "attention", "--no-cache"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(1)

      yield* runRootWith(["search", "attention", "--no-cache"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(2)

      const searchDir = join(cacheRoot, "search", "arxiv")
      const exists = yield* Effect.promise(() => readFile(searchDir).then(() => true, () => false))
      expect(exists).toBe(false)
    })))

  it.effect("malformed cache envelope is treated as miss", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = { search: () => { calls += 1; return decodeArxivFeed(arxivSearchXml) }, get: failingArxivGet }

      yield* Effect.promise(async () => {
        const dir = join(cacheRoot, "search", "arxiv")
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, "bad.json"), "not json", { encoding: "utf8" })
      })

      yield* runRootWith(["search", "attention"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(calls).toBe(1)
    })))

  it.effect("upstream query text is unchanged despite normalized cache key", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let capturedQuery = ""
      const client = makeArxivClient({
        fetchImpl: async (url) => {
          capturedQuery = new URL(url).searchParams.get("search_query") ?? ""
          return new Response(
            `<?xml version="1.0"?><feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults></feed>`,
            { status: 200 }
          )
        },
        timeoutMs: 1_000,
        retries: 0
      })

      yield* runRootWith(["search", "  Attention  Mechanism  "], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)
      expect(capturedQuery).toBe("all:  Attention  Mechanism  ")
    })))

  it.effect("cache clear removes search cache via full clear", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      const client = { search: () => decodeArxivFeed(arxivSearchXml), get: failingArxivGet }

      yield* runRootWith(["search", "attention"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)

      const searchDirBefore = join(cacheRoot, "search")
      const existsBefore = yield* Effect.promise(() => readdir(searchDirBefore).then(() => true, () => false))
      expect(existsBefore).toBe(true)

      const clearResult = yield* runRootWith(["cache", "clear"], { arxiv: unusedArxivClient, pubmed: unusedPubmedClient }, cacheRoot)
      expect(clearResult.exit._tag).toBe("Success")

      const searchDirAfter = join(cacheRoot, "search")
      const existsAfter = yield* Effect.promise(() => readdir(searchDirAfter).then(() => true, () => false))
      expect(existsAfter).toBe(false)
    })))

  it.effect("per-paper cache clear does not remove search cache", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      const client = { search: () => decodeArxivFeed(arxivSearchXml), get: failingArxivGet }

      yield* runRootWith(["search", "attention"], { arxiv: client, pubmed: unusedPubmedClient }, cacheRoot)

      const searchDirBefore = join(cacheRoot, "search")
      const existsBefore = yield* Effect.promise(() => readdir(searchDirBefore).then(() => true, () => false))
      expect(existsBefore).toBe(true)

      const clearResult = yield* runRootWith(["cache", "clear", "2401.04088"], { arxiv: unusedArxivClient, pubmed: unusedPubmedClient }, cacheRoot)
      expect(clearResult.exit._tag).toBe("Success")

      const searchDirAfter = join(cacheRoot, "search")
      const existsAfter = yield* Effect.promise(() => readdir(searchDirAfter).then(() => true, () => false))
      expect(existsAfter).toBe(true)
    })))

  it.effect("normalizeSearchQuery trims, lowercases, and collapses whitespace", () => Effect.gen(function*() {
    expect(normalizeSearchQuery("  Hello   World  ")).toBe("hello world")
    expect(normalizeSearchQuery("HELLO")).toBe("hello")
    expect(normalizeSearchQuery("a\t\nb")).toBe("a b")
    expect(normalizeSearchQuery("  ")).toBe("")
  }))
})

describe("PubMed search cache", () => {
  it.effect("first PubMed search misses cache, calls client, and writes cache envelope", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = makePubmedClient({
        fetchImpl: async (url) => {
          calls += 1
          return new Response(url.includes("esearch.fcgi") ? pubmedSearchJson : pubmedSummaryJson, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      const result = yield* runRootWith(["search", "covid", "--source", "pubmed", "--max", "2"], {
        arxiv: unusedArxivClient,
        pubmed: client
      }, cacheRoot)

      expect(result.exit._tag).toBe("Success")
      expect(calls).toBe(2)

      const files = yield* Effect.promise(() => readdir(join(cacheRoot, "search", "pubmed")).catch(() => []))
      expect(files.length).toBeGreaterThan(0)
    })))

  it.effect("second equivalent PubMed search hits cache and does not call client", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = makePubmedClient({
        fetchImpl: async (url) => {
          calls += 1
          return new Response(url.includes("esearch.fcgi") ? pubmedSearchJson : pubmedSummaryJson, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      const first = yield* runRootWith(["search", "covid", "--source", "pubmed", "--max", "2"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(first.exit._tag).toBe("Success")
      expect(calls).toBe(2)

      const second = yield* runRootWith(["search", "covid", "--source", "pubmed", "--max", "2"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(second.exit._tag).toBe("Success")
      expect(calls).toBe(2)
      expect(second.stdout).toContain("Found 42 papers (showing 2):")
    })))

  it.effect("equivalent PubMed query with different whitespace and case hits cache", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = makePubmedClient({
        fetchImpl: async (url) => {
          calls += 1
          return new Response(url.includes("esearch.fcgi") ? pubmedSearchJson : pubmedSummaryJson, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      yield* runRootWith(["search", "COVID 19", "--source", "pubmed", "--max", "2"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(2)

      yield* runRootWith(["search", "  covid 19  ", "--source", "pubmed", "--max", "2"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(2)
    })))

  it.effect("different PubMed max value misses cache and calls client again", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = makePubmedClient({
        fetchImpl: async (url) => {
          calls += 1
          return new Response(url.includes("esearch.fcgi") ? pubmedSearchJson : pubmedSummaryJson, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      yield* runRootWith(["search", "covid", "--source", "pubmed", "--max", "2"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(2)

      yield* runRootWith(["search", "covid", "--source", "pubmed", "--max", "5"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(4)
    })))

  it.effect("different PubMed sort value misses cache and calls client again", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = makePubmedClient({
        fetchImpl: async (url) => {
          calls += 1
          return new Response(url.includes("esearch.fcgi") ? pubmedSearchJson : pubmedSummaryJson, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      yield* runRootWith(["search", "covid", "--source", "pubmed", "--sort", "relevance"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(2)

      yield* runRootWith(["search", "covid", "--source", "pubmed", "--sort", "date"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(4)
    })))

  it.effect("stale PubMed cache is ignored and overwritten after successful fresh search", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = makePubmedClient({
        fetchImpl: async (url) => {
          calls += 1
          return new Response(url.includes("esearch.fcgi") ? pubmedSearchJson : pubmedSummaryJson, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      yield* runRootWith(["search", "covid", "--source", "pubmed"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(2)

      yield* TestClock.adjust(SEARCH_CACHE_TTL_MS + 1)

      yield* runRootWith(["search", "covid", "--source", "pubmed"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(4)
    })))

  it.effect("failed PubMed search does not create cache file", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      const client = {
        search: () => Effect.fail(new PubmedHttpError({ status: 503, message: "PubMed HTTP 503" })),
        get: failingPubmedGet
      }

      const result = yield* runRootWith(["search", "covid", "--source", "pubmed"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(result.exit._tag).toBe("Failure")

      const searchDir = join(cacheRoot, "search", "pubmed")
      const exists = yield* Effect.promise(() => readFile(searchDir).then(() => true, () => false))
      expect(exists).toBe(false)
    })))

  it.effect("cached PubMed result preserves decode warnings in rendered output", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      const client = makePubmedClient({
        fetchImpl: async (url) =>
          new Response(
            url.includes("esearch.fcgi")
              ? pubmedSearchJson
              : pubmedSummaryWithWarningJson,
            { status: 200 }
          ),
        timeoutMs: 1_000,
        retries: 0
      })

      const first = yield* runRootWith(["search", "covid", "--source", "pubmed", "--max", "2"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(first.stdout).toContain("PubMed partial failure: skipped malformed result")

      const second = yield* runRootWith(["search", "covid", "--source", "pubmed", "--max", "2"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(second.stdout).toContain("PubMed partial failure: skipped malformed result")
    })))

  it.effect("PubMed search --no-cache bypasses cache read and write", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = makePubmedClient({
        fetchImpl: async (url) => {
          calls += 1
          return new Response(url.includes("esearch.fcgi") ? pubmedSearchJson : pubmedSummaryJson, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      yield* runRootWith(["search", "covid", "--source", "pubmed", "--no-cache"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(2)

      yield* runRootWith(["search", "covid", "--source", "pubmed", "--no-cache"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(4)

      const searchDir = join(cacheRoot, "search", "pubmed")
      const exists = yield* Effect.promise(() => readFile(searchDir).then(() => true, () => false))
      expect(exists).toBe(false)
    })))

  it.effect("same query for arXiv and PubMed creates separate cache namespaces", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let arxivCalls = 0
      let pubmedCalls = 0
      const arxivClient = { search: () => { arxivCalls += 1; return decodeArxivFeed(arxivSearchXml) }, get: failingArxivGet }
      const pubmedClient = makePubmedClient({
        fetchImpl: async (url) => {
          pubmedCalls += 1
          return new Response(url.includes("esearch.fcgi") ? pubmedSearchJson : pubmedSummaryJson, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      yield* runRootWith(["search", "attention", "--max", "2"], { arxiv: arxivClient, pubmed: pubmedClient }, cacheRoot)
      expect(arxivCalls).toBe(1)
      expect(pubmedCalls).toBe(0)

      yield* runRootWith(["search", "attention", "--source", "pubmed", "--max", "2"], { arxiv: arxivClient, pubmed: pubmedClient }, cacheRoot)
      expect(arxivCalls).toBe(1)
      expect(pubmedCalls).toBe(2)

      yield* runRootWith(["search", "attention", "--max", "2"], { arxiv: arxivClient, pubmed: pubmedClient }, cacheRoot)
      expect(arxivCalls).toBe(1)
      expect(pubmedCalls).toBe(2)

      yield* runRootWith(["search", "attention", "--source", "pubmed", "--max", "2"], { arxiv: arxivClient, pubmed: pubmedClient }, cacheRoot)
      expect(arxivCalls).toBe(1)
      expect(pubmedCalls).toBe(2)
    })))

  it.effect("malformed PubMed cache envelope is treated as miss", () =>
    withTempCache((cacheRoot) => Effect.gen(function*() {
      let calls = 0
      const client = makePubmedClient({
        fetchImpl: async (url) => {
          calls += 1
          return new Response(url.includes("esearch.fcgi") ? pubmedSearchJson : pubmedSummaryJson, { status: 200 })
        },
        timeoutMs: 1_000,
        retries: 0
      })

      yield* Effect.promise(async () => {
        const dir = join(cacheRoot, "search", "pubmed")
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, "bad.json"), "not json", { encoding: "utf8" })
      })

      yield* runRootWith(["search", "covid", "--source", "pubmed"], { arxiv: unusedArxivClient, pubmed: client }, cacheRoot)
      expect(calls).toBe(2)
    })))
})
