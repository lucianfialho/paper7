import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  BenchmarkCalculationError,
  BenchmarkDecodeError,
  BenchmarkLiveIo,
  BenchmarkNetworkError,
  BenchmarkProcessError,
  BenchmarkReadError,
  BenchmarkWriteError,
  calculateBenchmark,
  getBenchmarkReport,
  renderBenchmarkMarkdownTable,
  renderBenchmarkTable,
  runBenchmark,
  runLiveBenchmark
} from "../src/benchmark.js"

describe("calculateBenchmark", () => {
  it.effect("preserves old byte-to-KB and percent reduction semantics", () =>
    Effect.gen(function* () {
      const artifacts = [
        {
          name: "Test Paper",
          arxivId: "1234.56789",
          pages: 10,
          pdfBytes: 10240,
          htmlBytes: 5120,
          paper7Path: "test/paper7.md"
        }
      ] as const

      const sizes = new Map<string, number>([["test/paper7.md", 1024]])
      const report = yield* calculateBenchmark(artifacts, sizes)

      expect(report.rows).toHaveLength(1)
      const row = report.rows[0]
      expect(row.label).toBe("Test Paper (1234.56789)")
      expect(row.pages).toBe(10)
      expect(row.pdfBytes).toBe(10240)
      expect(row.htmlBytes).toBe(5120)
      expect(row.paper7Bytes).toBe(1024)
      expect(row.vsPdfPercent).toBe(-90)
      expect(row.vsHtmlPercent).toBe(-80)
    }))

  it.effect("computes correct totals", () =>
    Effect.gen(function* () {
      const artifacts = [
        {
          name: "A",
          arxivId: "1111.11111",
          pages: 5,
          pdfBytes: 2048,
          htmlBytes: 1024,
          paper7Path: "a/paper7.md"
        },
        {
          name: "B",
          arxivId: "2222.22222",
          pages: 3,
          pdfBytes: 4096,
          htmlBytes: 2048,
          paper7Path: "b/paper7.md"
        }
      ] as const

      const sizes = new Map<string, number>([
        ["a/paper7.md", 512],
        ["b/paper7.md", 256]
      ])

      const report = yield* calculateBenchmark(artifacts, sizes)

      expect(report.total.pages).toBe(8)
      expect(report.total.pdfBytes).toBe(6144)
      expect(report.total.htmlBytes).toBe(3072)
      expect(report.total.paper7Bytes).toBe(768)
      expect(report.total.vsPdfPercent).toBe(-87)
      expect(report.total.vsHtmlPercent).toBe(-75)
    }))

  it.effect("returns BenchmarkCalculationError for missing paper7Path", () =>
    Effect.gen(function* () {
      const artifacts = [
        {
          name: "Missing",
          arxivId: "9999.99999",
          pages: 1,
          pdfBytes: 1024,
          htmlBytes: 512,
          paper7Path: "missing/paper7.md"
        }
      ] as const

      const sizes = new Map<string, number>()
      const result = yield* calculateBenchmark(artifacts, sizes).pipe(
        Effect.catchTag("BenchmarkCalculationError", (error) => Effect.succeed(error))
      )

      expect(result).toBeInstanceOf(BenchmarkCalculationError)
      expect(result.paper7Path).toBe("missing/paper7.md")
      expect(result.message).toBe("missing paper7 size for missing/paper7.md")
    }))
})

describe("renderBenchmarkTable", () => {
  it.effect("includes all required columns and total row", () =>
    Effect.gen(function* () {
      const report = yield* calculateBenchmark(
        [
          {
            name: "Test",
            arxivId: "1234.56789",
            pages: 1,
            pdfBytes: 1024,
            htmlBytes: 512,
            paper7Path: "test/paper7.md"
          }
        ],
        new Map<string, number>([["test/paper7.md", 128]])
      )

      const table = renderBenchmarkTable(report)

      expect(table).toContain("Paper")
      expect(table).toContain("Pages")
      expect(table).toContain("PDF")
      expect(table).toContain("HTML")
      expect(table).toContain("paper7")
      expect(table).toContain("vs PDF")
      expect(table).toContain("vs HTML")
      expect(table).toContain("TOTAL")
      expect(table).toContain("Test (1234.56789)")
    }))
})

describe("renderBenchmarkMarkdownTable", () => {
  it.effect("renders markdown rows without bold percentages by default", () =>
    Effect.gen(function* () {
      const report = yield* calculateBenchmark(
        [
          {
            name: "Test",
            arxivId: "1234.56789",
            pages: 1,
            pdfBytes: 1024,
            htmlBytes: 512,
            paper7Path: "test/paper7.md"
          }
        ],
        new Map<string, number>([["test/paper7.md", 128]])
      )

      const markdown = renderBenchmarkMarkdownTable(report)

      expect(markdown).toContain("| Test | 1 | 1KB | 0KB | 0KB | -87% | -75% |")
      expect(markdown).toContain("| **Total** | **1** | **1KB** | **0KB** | **0KB** | **-87%** | **-75%** |")
    }))

  it.effect("renders markdown rows with bold percentages when requested", () =>
    Effect.gen(function* () {
      const report = yield* calculateBenchmark(
        [
          {
            name: "Test",
            arxivId: "1234.56789",
            pages: 1,
            pdfBytes: 1024,
            htmlBytes: 512,
            paper7Path: "test/paper7.md"
          }
        ],
        new Map<string, number>([["test/paper7.md", 128]])
      )

      const markdown = renderBenchmarkMarkdownTable(report, { boldPercentages: true })

      expect(markdown).toContain("| Test | 1 | 1KB | 0KB | 0KB | **-87%** | **-75%** |")
    }))
})

describe("getBenchmarkReport", () => {
  it.effect("returns deterministic report for checked-in artifacts", () =>
    Effect.gen(function* () {
      const report = yield* getBenchmarkReport()

      expect(report.rows).toHaveLength(5)
      expect(report.total.pages).toBe(169)
      expect(report.total.pdfBytes).toBe(12431634)
      expect(report.total.htmlBytes).toBe(2582565)
      expect(report.total.paper7Bytes).toBe(357519)
      expect(report.total.vsPdfPercent).toBe(-97)
      expect(report.total.vsHtmlPercent).toBe(-86)
    }))
})

describe("runBenchmark", () => {
  it.effect("reads checked-in artifacts and returns deterministic output without network", () =>
    Effect.gen(function*() {
      const output = yield* runBenchmark()

      expect(output).toContain("Running paper7 benchmark...")
      expect(output).toContain("Attention Is All You Need")
      expect(output).toContain("RAG")
      expect(output).toContain("Mixtral of Experts")
      expect(output).toContain("GPT-4 Technical Report")
      expect(output).toContain("LoRA")
      expect(output).toContain("TOTAL")
      expect(output).toContain("Done.")
    }))

  it.effect("returns BenchmarkReadError for missing manifest", () =>
    Effect.gen(function*() {
      const result = yield* runBenchmark("nonexistent-dir").pipe(
        Effect.catchTag("BenchmarkReadError", (error) => Effect.succeed(error))
      )

      expect(result).toBeInstanceOf(BenchmarkReadError)
      expect(result.path).toContain("manifest.json")
    }))

  it.effect("returns BenchmarkDecodeError for malformed manifest", () =>
    Effect.gen(function*() {
      const result = yield* runBenchmark("tests/fixtures/benchmark-malformed").pipe(
        Effect.catchTag("BenchmarkDecodeError", (error) => Effect.succeed(error))
      )

      expect(result).toBeInstanceOf(BenchmarkDecodeError)
    }))

  it.effect("returns BenchmarkDecodeError for syntax-error JSON", () =>
    Effect.gen(function*() {
      const result = yield* runBenchmark("tests/fixtures/benchmark-syntax-error").pipe(
        Effect.catchTag("BenchmarkDecodeError", (error) => Effect.succeed(error))
      )

      expect(result).toBeInstanceOf(BenchmarkDecodeError)
      expect(result.message).toBe("invalid JSON")
    }))
})

describe("calculateBenchmark edge cases", () => {
  it.effect("returns zero-total report for empty artifacts", () =>
    Effect.gen(function* () {
      const report = yield* calculateBenchmark([], new Map())
      expect(report.rows).toHaveLength(0)
      expect(report.total.pages).toBe(0)
      expect(report.total.pdfBytes).toBe(0)
      expect(report.total.htmlBytes).toBe(0)
      expect(report.total.paper7Bytes).toBe(0)
    }))
})

const withTempBenchmark = <A, E, R>(effect: (dir: string) => Effect.Effect<A, E, R>): Effect.Effect<A, E | BenchmarkWriteError, R> =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "paper7-bench-")))
    yield* Effect.promise(async () => {
      await mkdir(join(dir, "test"), { recursive: true })
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify([
          { name: "Fixture Paper", arxivId: "1234.56789", pages: 5, pdfBytes: 1024, htmlBytes: 512, paper7Path: "test/paper7.md" }
        ]),
        { encoding: "utf8" }
      )
      await writeFile(join(dir, "test", "paper7.md"), "# Fixture\n", { encoding: "utf8" })
    })
    return yield* effect(dir)
  })

const fakeLiveIo = Layer.succeed(BenchmarkLiveIo, {
  refreshPaper7: () => Effect.void,
  measureSourceBytes: () => Effect.succeed(2048)
})

const fakeLiveIoFailingNetwork = Layer.succeed(BenchmarkLiveIo, {
  refreshPaper7: () => Effect.void,
  measureSourceBytes: () =>
    Effect.fail(
      new BenchmarkNetworkError({
        source: "pdf",
        url: "https://arxiv.org/pdf/1234.56789",
        message: "network failure",
        cause: "fake"
      })
    )
})

const fakeLiveIoFailingProcess = Layer.succeed(BenchmarkLiveIo, {
  refreshPaper7: () =>
    Effect.fail(
      new BenchmarkProcessError({
        arxivId: "1234.56789",
        command: "tsx src/cli.ts get 1234.56789 --detailed --no-cache --no-tldr",
        message: "process exited with code 1",
        exitCode: 1,
        stderr: "error"
      })
    ),
  measureSourceBytes: () => Effect.succeed(2048)
})

describe("runLiveBenchmark", () => {
  it.effect("refreshes artifacts and renders through deterministic path", () =>
    withTempBenchmark((dir) =>
      Effect.gen(function* () {
        const output = yield* runLiveBenchmark(dir).pipe(Effect.provide(fakeLiveIo))
        expect(output).toContain("Running paper7 benchmark...")
        expect(output).toContain("Fixture Paper")
        expect(output).toContain("TOTAL")
      })
    ))

  it.effect("returns BenchmarkNetworkError when measureSourceBytes fails", () =>
    withTempBenchmark((dir) =>
      Effect.gen(function* () {
        const result = yield* runLiveBenchmark(dir).pipe(
          Effect.provide(fakeLiveIoFailingNetwork),
          Effect.catchTag("BenchmarkNetworkError", (error) => Effect.succeed(error))
        )
        expect(result).toBeInstanceOf(BenchmarkNetworkError)
        expect(result.source).toBe("pdf")
        expect(result.url).toContain("arxiv.org/pdf")
      })
    ))

  it.effect("returns BenchmarkProcessError when refreshPaper7 fails", () =>
    withTempBenchmark((dir) =>
      Effect.gen(function* () {
        const result = yield* runLiveBenchmark(dir).pipe(
          Effect.provide(fakeLiveIoFailingProcess),
          Effect.catchTag("BenchmarkProcessError", (error) => Effect.succeed(error))
        )
        expect(result).toBeInstanceOf(BenchmarkProcessError)
        expect(result.arxivId).toBe("1234.56789")
        expect(result.exitCode).toBe(1)
      })
    ))
})
