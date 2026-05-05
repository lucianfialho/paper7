import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { getBenchmarkReport, renderBenchmarkMarkdownTable } from "../src/benchmark.js"

const readText = (path: string): string => readFileSync(path, "utf8")

const section = (text: string, start: string, end: string): string => {
  const startIndex = text.indexOf(start)
  const endIndex = text.indexOf(end, startIndex + start.length)
  if (startIndex < 0 || endIndex < 0) return ""
  return text.slice(startIndex, endIndex)
}

describe("docs hardening", () => {
  it("documents npm and npx install paths only", () => {
    const readme = readText("README.md")
    const install = section(readme, "## Install", "## AI Agent Skill")

    expect(install).toContain("npm install -g @p7dotorg/paper7")
    expect(install).toContain("npx @p7dotorg/paper7")
    expect(install).not.toMatch(/curl|install\.sh|\| bash/)
  })

  it("does not ship or document unsafe shell installer", () => {
    const markdown = [
      "README.md",
      "llms.txt",
      "docs/sources.md",
      "skills/paper7/SKILL.md",
      "skills/paper7-research/SKILL.md"
    ].map(readText).join("\n")

    expect(existsSync("install.sh")).toBe(false)
    expect(markdown).not.toMatch(/install\.sh|curl[^\n]*\|[^\n]*bash/)
  })

  it("documents trust boundary and supported sources", () => {
    const skillDocs = `${readText("skills/paper7/SKILL.md")}\n${readText("skills/paper7-research/SKILL.md")}`

    expect(skillDocs).toMatch(/untrusted external data/i)
    expect(skillDocs).toContain("arXiv")
    expect(skillDocs).toContain("PubMed")
    expect(skillDocs).toContain("DOI")
  })

  it("documents default deterministic suite and shell migration matrix", () => {
    const testsReadme = readText("tests/README.md")
    const requiredScenarios = [
      "CLI skeleton",
      "Typed CLI boundary",
      "arXiv search",
      "PubMed search",
      "arXiv get",
      "PubMed get",
      "DOI get",
      "get modes",
      "abstract-only",
      "refs",
      "repo",
      "cite",
      "cache",
      "vault",
      "browse",
      "kb",
      "README docs",
      "release hardening",
      "Semantic Scholar"
    ]

    expect(testsReadme).toContain("bun run test")
    expect(testsReadme).toContain("@effect/vitest")
    expect(testsReadme).toMatch(/Default test path[\s\S]*@effect\/vitest/i)
    expect(testsReadme).toMatch(/Live upstream checks are not part of the default suite/i)
    expect(testsReadme).not.toMatch(/test_.*\.sh|PAPER7_LIVE|PAPER7=\/path/)
    expect(testsReadme).not.toMatch(/for t in tests\/test_\*\.sh/)

    for (const scenario of requiredScenarios) {
      expect(testsReadme).toContain(`| ${scenario} |`)
    }
  })

  it("documents a real maintainer-owned Crossref email", () => {
    const sources = readText("docs/sources.md")
    expect(sources).not.toContain("paper7@example.com")
    expect(sources).toContain("edu.santos.brito@gmail.com")
  })

  it("links README license to committed LICENSE file", () => {
    const readme = readText("README.md")
    expect(readme).toContain("[MIT](LICENSE)")
    expect(existsSync("LICENSE")).toBe(true)
  })

  it("documents benchmark via package command, not shell runner", () => {
    const benchmarkReadme = readText("benchmark/README.md")

    expect(benchmarkReadme).toContain("bun run benchmark")
    expect(benchmarkReadme).toContain("bun run benchmark:live")
    expect(benchmarkReadme).not.toContain("benchmark/run.sh")
    expect(benchmarkReadme).not.toContain("./benchmark/run.sh")
    expect(benchmarkReadme).not.toMatch(/run_benchmark|run-benchmark|benchmark\.sh/)
  })

  it.effect("benchmark/README.md benchmark table matches deterministic output", () =>
    Effect.gen(function* () {
      const report = yield* getBenchmarkReport()
      const expectedRows = renderBenchmarkMarkdownTable(report, { boldPercentages: true })
      const benchmarkReadme = readText("benchmark/README.md")
      expect(benchmarkReadme).toContain(expectedRows)
    }))
})
