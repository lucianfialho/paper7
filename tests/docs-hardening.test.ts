import { describe, expect, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"

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

    expect(install).toContain("npm install -g @guataiba/paper7")
    expect(install).toContain("npx @guataiba/paper7")
    expect(install).not.toMatch(/curl|install\.sh|\| bash/)
  })

  it("does not ship or document unsafe shell installer", () => {
    const markdown = [
      "README.md",
      "claude-code/README.md",
      "claude-code/paper7.md",
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
      "refs",
      "repo",
      "cache",
      "vault",
      "browse",
      "README docs",
      "release hardening",
      "Semantic Scholar"
    ]

    expect(testsReadme).toContain("bun run test")
    expect(testsReadme).toContain("@effect/vitest")
    expect(testsReadme).toMatch(/Default test path[\s\S]*does not run.*test_.*\.sh/i)
    expect(testsReadme).toMatch(/Live smoke.*PAPER7_LIVE_/i)
    expect(testsReadme).toMatch(/Process parity.*opt-in/i)
    expect(testsReadme).not.toMatch(/for t in tests\/test_\*\.sh/)

    for (const scenario of requiredScenarios) {
      expect(testsReadme).toContain(`| ${scenario} |`)
    }
  })
})
