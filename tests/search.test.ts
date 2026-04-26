import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CliOutput, Command } from "effect/unstable/cli"
import { ArxivClient, decodeArxivFeed, makeArxivClient, type ArxivClientShape, type ArxivError } from "../src/arxiv.js"
import { rootCommand, VERSION } from "../src/cli.js"
import { PubmedClient, decodeSearchResponse, makePubmedClient, type PubmedClientShape, type PubmedError } from "../src/pubmed.js"

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

const unexpectedArxivGet: ArxivError = { _tag: "ArxivDecodeError", message: "unexpected get" }
const unexpectedPubmedGet: PubmedError = { _tag: "PubmedDecodeError", message: "unexpected get" }

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
  search: () => Effect.fail({ _tag: "PubmedDecodeError", message: "unexpected search" }),
  get: failingPubmedGet
}

const unusedArxivClient: ArxivClientShape = {
  search: () => Effect.fail({ _tag: "ArxivDecodeError", message: "unexpected search" }),
  get: failingArxivGet
}

const runRootWith = (
  args: ReadonlyArray<string>,
  clients: {
    readonly arxiv: ArxivClientShape
    readonly pubmed: PubmedClientShape
  }
) =>
  Effect.gen(function*() {
    const testConsole = yield* TestConsole.make
    const program = Command.runWith(rootCommand, { version: VERSION })(args).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(ArxivClient, clients.arxiv),
      Effect.provideService(PubmedClient, clients.pubmed)
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
})
