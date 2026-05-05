import { Console, Context, Data, Effect, Layer, Stream } from "effect"
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { pathToFileURL } from "node:url"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as FileSystem from "effect/FileSystem"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export type BenchmarkArtifact = {
  readonly name: string
  readonly arxivId: string
  readonly pages: number
  readonly pdfBytes: number
  readonly htmlBytes: number
  readonly paper7Path: string
}

export type BenchmarkRow = {
  readonly name: string
  readonly arxivId: string
  readonly label: string
  readonly pages: number
  readonly pdfBytes: number
  readonly htmlBytes: number
  readonly paper7Bytes: number
  readonly vsPdfPercent: number
  readonly vsHtmlPercent: number
}

export type BenchmarkReport = {
  readonly rows: ReadonlyArray<BenchmarkRow>
  readonly total: BenchmarkRow
}

export class BenchmarkReadError extends Data.TaggedError("BenchmarkReadError")<{
  readonly path: string
  readonly message: string
  readonly cause: unknown
}> {}

export class BenchmarkDecodeError extends Data.TaggedError("BenchmarkDecodeError")<{
  readonly path: string
  readonly message: string
}> {}

export class BenchmarkWriteError extends Data.TaggedError("BenchmarkWriteError")<{
  readonly path: string
  readonly message: string
  readonly cause: unknown
}> {}

export class BenchmarkNetworkError extends Data.TaggedError("BenchmarkNetworkError")<{
  readonly source: "pdf" | "html"
  readonly url: string
  readonly message: string
  readonly cause: unknown
}> {}

export class BenchmarkProcessError extends Data.TaggedError("BenchmarkProcessError")<{
  readonly arxivId: string
  readonly command: string
  readonly message: string
  readonly exitCode?: number
  readonly stderr?: string
  readonly cause?: unknown
}> {}

export class BenchmarkCalculationError extends Data.TaggedError("BenchmarkCalculationError")<{
  readonly paper7Path: string
  readonly message: string
}> {}

export type BenchmarkError =
  | BenchmarkReadError
  | BenchmarkDecodeError
  | BenchmarkWriteError
  | BenchmarkNetworkError
  | BenchmarkProcessError
  | BenchmarkCalculationError

const fmtKb = (bytes: number): string => `${Math.trunc(bytes / 1024)}KB`

const fmtKbCommas = (bytes: number): string => {
  const kb = Math.trunc(bytes / 1024)
  return kb.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "KB"
}

const pct = (sourceBytes: number, paper7Bytes: number): number =>
  sourceBytes === 0 ? 0 : Math.trunc((paper7Bytes - sourceBytes) * 100 / sourceBytes)

export const calculateBenchmark = (
  artifacts: ReadonlyArray<BenchmarkArtifact>,
  paper7Sizes: ReadonlyMap<string, number>
): Effect.Effect<BenchmarkReport, BenchmarkCalculationError> =>
  Effect.gen(function* () {
    const rows: Array<BenchmarkRow> = []

    for (const artifact of artifacts) {
      const paper7Bytes = paper7Sizes.get(artifact.paper7Path)
      if (paper7Bytes === undefined) {
        yield* Effect.fail(
          new BenchmarkCalculationError({
            paper7Path: artifact.paper7Path,
            message: `missing paper7 size for ${artifact.paper7Path}`
          })
        )
      } else {
        rows.push({
          name: artifact.name,
          arxivId: artifact.arxivId,
          label: `${artifact.name} (${artifact.arxivId})`,
          pages: artifact.pages,
          pdfBytes: artifact.pdfBytes,
          htmlBytes: artifact.htmlBytes,
          paper7Bytes,
          vsPdfPercent: pct(artifact.pdfBytes, paper7Bytes),
          vsHtmlPercent: pct(artifact.htmlBytes, paper7Bytes)
        })
      }
    }

    const totalSums = rows.reduce(
      (acc, row) => ({
        pages: acc.pages + row.pages,
        pdfBytes: acc.pdfBytes + row.pdfBytes,
        htmlBytes: acc.htmlBytes + row.htmlBytes,
        paper7Bytes: acc.paper7Bytes + row.paper7Bytes
      }),
      {
        pages: 0,
        pdfBytes: 0,
        htmlBytes: 0,
        paper7Bytes: 0
      }
    )

    const total: BenchmarkRow = {
      name: "Total",
      arxivId: "",
      label: "TOTAL",
      pages: totalSums.pages,
      pdfBytes: totalSums.pdfBytes,
      htmlBytes: totalSums.htmlBytes,
      paper7Bytes: totalSums.paper7Bytes,
      vsPdfPercent: pct(totalSums.pdfBytes, totalSums.paper7Bytes),
      vsHtmlPercent: pct(totalSums.htmlBytes, totalSums.paper7Bytes)
    }

    return { rows, total }
  })

export const renderBenchmarkTable = (report: BenchmarkReport): string => {
  const lines: Array<string> = []

  lines.push(
    `Running paper7 benchmark...\n`,
    `${left("Paper", 30)} ${right("Pages", 6)} ${right("PDF", 8)} ${right("HTML", 10)} ${right("paper7", 10)} ${right("vs PDF", 8)} ${right("vs HTML", 8)}`,
    `${left("-", 30, "-")} ${right("-", 6, "-")} ${right("-", 8, "-")} ${right("-", 10, "-")} ${right("-", 10, "-")} ${right("-", 8, "-")} ${right("-", 8, "-")}`
  )

  for (const row of report.rows) {
    lines.push(renderRow(row))
  }

  lines.push("")
  lines.push(renderRow(report.total))
  lines.push("")
  lines.push("Done. Results saved in benchmark/*/paper7.md")

  return lines.join("\n")
}

const renderRow = (row: BenchmarkRow): string =>
  `${left(row.label, 30)} ${right(String(row.pages), 6)} ${right(fmtKb(row.pdfBytes), 8)} ${right(fmtKb(row.htmlBytes), 10)} ${right(fmtKb(row.paper7Bytes), 10)} ${right(`${row.vsPdfPercent}%`, 8)} ${right(`${row.vsHtmlPercent}%`, 8)}`

const left = (text: string, width: number, pad = " "): string =>
  text.length >= width ? text.slice(0, width) : text + pad.repeat(width - text.length)

const right = (text: string, width: number, pad = " "): string =>
  text.length >= width ? text.slice(0, width) : pad.repeat(width - text.length) + text

const readManifest = (root: string): Effect.Effect<ReadonlyArray<BenchmarkArtifact>, BenchmarkError> =>
  Effect.tryPromise({
    try: async () => {
      const path = join(root, "manifest.json")
      const content = await readFile(path, { encoding: "utf8" })
      return content
    },
    catch: (cause): BenchmarkError =>
      new BenchmarkReadError({ path: join(root, "manifest.json"), message: "failed to read manifest", cause })
  }).pipe(
    Effect.flatMap((content) =>
      Effect.try({
        try: (): unknown => JSON.parse(content),
        catch: (): BenchmarkDecodeError =>
          new BenchmarkDecodeError({ path: join(root, "manifest.json"), message: "invalid JSON" })
      })
    )
  ).pipe(
    Effect.flatMap((parsed) => {
      if (!Array.isArray(parsed)) {
        return Effect.fail(new BenchmarkDecodeError({ path: join(root, "manifest.json"), message: "expected array" }))
      }

      const artifacts: Array<BenchmarkArtifact> = []
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i]
        if (!isRecord(item)) {
          return Effect.fail(new BenchmarkDecodeError({ path: join(root, "manifest.json"), message: `expected object at index ${i}` }))
        }

        const name = getString(item.name)
        const arxivId = getString(item.arxivId)
        const pages = getNumber(item.pages)
        const pdfBytes = getNumber(item.pdfBytes)
        const htmlBytes = getNumber(item.htmlBytes)
        const paper7Path = getString(item.paper7Path)

        if (
          name === undefined ||
          arxivId === undefined ||
          pages === undefined ||
          pdfBytes === undefined ||
          htmlBytes === undefined ||
          paper7Path === undefined
        ) {
          return Effect.fail(new BenchmarkDecodeError({ path: join(root, "manifest.json"), message: `missing field at index ${i}` }))
        }

        artifacts.push({ name, arxivId, pages, pdfBytes, htmlBytes, paper7Path })
      }

      return Effect.succeed(artifacts)
    })
  )

const readPaper7Sizes = (
  root: string,
  artifacts: ReadonlyArray<BenchmarkArtifact>
): Effect.Effect<ReadonlyMap<string, number>, BenchmarkError> =>
  Effect.gen(function*() {
    const sizes = new Map<string, number>()

    for (const artifact of artifacts) {
      const path = join(root, artifact.paper7Path)
      const content = yield* Effect.tryPromise({
        try: async () => readFile(path, { encoding: "utf8" }),
        catch: (cause): BenchmarkError =>
          new BenchmarkReadError({ path, message: "failed to read paper7 output", cause })
      })
      sizes.set(artifact.paper7Path, Buffer.byteLength(content, "utf8"))
    }

    return sizes
  })

const writeManifest = (
  root: string,
  artifacts: ReadonlyArray<BenchmarkArtifact>
): Effect.Effect<void, BenchmarkWriteError> =>
  Effect.tryPromise({
    try: async () => {
      const path = join(root, "manifest.json")
      await writeFile(path, JSON.stringify(artifacts, null, 2) + "\n", { encoding: "utf8" })
    },
    catch: (cause): BenchmarkWriteError =>
      new BenchmarkWriteError({ path: join(root, "manifest.json"), message: "failed to write manifest", cause })
  })

export type BenchmarkLiveIoShape = {
  readonly refreshPaper7: (
    artifact: BenchmarkArtifact,
    root: string
  ) => Effect.Effect<void, BenchmarkProcessError | BenchmarkWriteError>

  readonly measureSourceBytes: (
    artifact: BenchmarkArtifact,
    source: "pdf" | "html"
  ) => Effect.Effect<number, BenchmarkNetworkError>
}

export class BenchmarkLiveIo extends Context.Service<BenchmarkLiveIo, BenchmarkLiveIoShape>()("paper7/BenchmarkLiveIo") {}

export const BenchmarkLiveIoLive: Layer.Layer<
  BenchmarkLiveIo,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient | ChildProcessSpawner
> = Layer.effect(BenchmarkLiveIo, Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const http = yield* HttpClient.HttpClient
  const spawner = yield* ChildProcessSpawner

  return {
    refreshPaper7: (artifact, root) =>
      Effect.gen(function*() {
        const command = ChildProcess.make`tsx src/cli.ts get ${artifact.arxivId} --detailed --no-cache --no-tldr`
        const handle = yield* spawner.spawn(command)
        const [stdoutChunks, stderrChunks] = yield* Effect.all(
          [
            Stream.runCollect(handle.stdout.pipe(Stream.decodeText())),
            Stream.runCollect(handle.stderr.pipe(Stream.decodeText()))
          ],
          { concurrency: 2 }
        )
        const exitCode = yield* handle.exitCode
        const stdout = stdoutChunks.join("")
        const stderr = stderrChunks.join("")

        if (exitCode !== 0) {
          yield* new BenchmarkProcessError({
            arxivId: artifact.arxivId,
            command: `tsx src/cli.ts get ${artifact.arxivId} --detailed --no-cache --no-tldr`,
            message: `process exited with code ${exitCode}`,
            exitCode,
            stderr
          })
          return
        }

        const path = join(root, artifact.paper7Path)
        yield* fs.writeFileString(path, stdout)
      }).pipe(
        Effect.scoped,
        Effect.catch((error): Effect.Effect<never, BenchmarkProcessError | BenchmarkWriteError> => {
          if (error instanceof BenchmarkProcessError) return Effect.fail(error)
          return Effect.fail(new BenchmarkWriteError({
            path: join(root, artifact.paper7Path),
            message: "failed to refresh paper7 output",
            cause: error
          }))
        })
      ),

    measureSourceBytes: (artifact, source) =>
      Effect.gen(function*() {
        const url =
          source === "pdf"
            ? `https://arxiv.org/pdf/${artifact.arxivId}`
            : `https://ar5iv.labs.arxiv.org/html/${artifact.arxivId}`

        const response = yield* http.get(url).pipe(
          Effect.mapError(
            (cause): BenchmarkNetworkError =>
              new BenchmarkNetworkError({
                source,
                url,
                message: `failed to fetch ${source}`,
                cause
              })
          )
        )

        const buffer = yield* response.arrayBuffer.pipe(
          Effect.mapError(
            (cause): BenchmarkNetworkError =>
              new BenchmarkNetworkError({
                source,
                url,
                message: `failed to read ${source} response`,
                cause
              })
          )
        )

        return buffer.byteLength
      })
  }
}))

export const refreshBenchmarkArtifacts = (
  root = "benchmark"
): Effect.Effect<ReadonlyArray<BenchmarkArtifact>, BenchmarkError, BenchmarkLiveIo> =>
  Effect.gen(function*() {
    const artifacts = yield* readManifest(root)
    const liveIo = yield* BenchmarkLiveIo

    const refreshed: Array<BenchmarkArtifact> = []

    for (const artifact of artifacts) {
      yield* liveIo.refreshPaper7(artifact, root)
      const pdfBytes = yield* liveIo.measureSourceBytes(artifact, "pdf")
      const htmlBytes = yield* liveIo.measureSourceBytes(artifact, "html")

      refreshed.push({
        name: artifact.name,
        arxivId: artifact.arxivId,
        pages: artifact.pages,
        pdfBytes,
        htmlBytes,
        paper7Path: artifact.paper7Path
      })
    }

    yield* writeManifest(root, refreshed)
    return refreshed
  })

export const runLiveBenchmark = (
  root = "benchmark"
): Effect.Effect<string, BenchmarkError, BenchmarkLiveIo> =>
  Effect.gen(function*() {
    yield* refreshBenchmarkArtifacts(root)
    return yield* runBenchmark(root)
  })

export type BenchmarkMarkdownTableOptions = {
  readonly boldPercentages: boolean
}

export const renderBenchmarkMarkdownTable = (
  report: BenchmarkReport,
  options?: BenchmarkMarkdownTableOptions
): string => {
  const bold = options?.boldPercentages ?? false
  const lines: Array<string> = []

  for (const row of report.rows) {
    const vsPdf = bold ? `**${row.vsPdfPercent}%**` : `${row.vsPdfPercent}%`
    const vsHtml = bold ? `**${row.vsHtmlPercent}%**` : `${row.vsHtmlPercent}%`
    lines.push(
      `| ${row.name} | ${row.pages} | ${fmtKbCommas(row.pdfBytes)} | ${fmtKbCommas(row.htmlBytes)} | ${fmtKbCommas(row.paper7Bytes)} | ${vsPdf} | ${vsHtml} |`
    )
  }

  lines.push(
    `| **Total** | **${report.total.pages}** | **${fmtKbCommas(report.total.pdfBytes)}** | **${fmtKbCommas(report.total.htmlBytes)}** | **${fmtKbCommas(report.total.paper7Bytes)}** | **${report.total.vsPdfPercent}%** | **${report.total.vsHtmlPercent}%** |`
  )

  return lines.join("\n")
}

export const getBenchmarkReport = (root = "benchmark"): Effect.Effect<BenchmarkReport, BenchmarkError> =>
  Effect.gen(function*() {
    const artifacts = yield* readManifest(root)
    const paper7Sizes = yield* readPaper7Sizes(root, artifacts)
    return yield* calculateBenchmark(artifacts, paper7Sizes)
  })

export const runBenchmark = (root = "benchmark"): Effect.Effect<string, BenchmarkError> =>
  Effect.gen(function*() {
    const report = yield* getBenchmarkReport(root)
    return renderBenchmarkTable(report)
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const getNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const args = process.argv.slice(2)
  const isLive = args.includes("--live")

  if (args.length > 0 && !isLive) {
    NodeRuntime.runMain(
      Effect.fail(new BenchmarkDecodeError({ path: "argv", message: `unknown arguments: ${args.join(" ")}` })),
      { disableErrorReporting: true }
    )
  } else if (isLive) {
    NodeRuntime.runMain(
      Effect.gen(function*() {
        const output = yield* runLiveBenchmark()
        yield* Console.log(output)
      }).pipe(
        Effect.provide(BenchmarkLiveIoLive),
        Effect.provide(NodeHttpClient.layerFetch),
        Effect.provide(NodeServices.layer)
      ),
      { disableErrorReporting: true }
    )
  } else {
    NodeRuntime.runMain(
      Effect.gen(function*() {
        const output = yield* runBenchmark()
        yield* Console.log(output)
      }),
      { disableErrorReporting: true }
    )
  }
}
