import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const readText = (path: string): string => readFileSync(path, "utf8")

const packageJson: unknown = JSON.parse(readText("package.json"))

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value
  throw new Error("expected object")
}

const stringRecord = (value: unknown): Record<string, string> => {
  const input = record(value)
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== "string") throw new Error(`expected string value for ${key}`)
    output[key] = item
  }
  return output
}

describe("package hardening", () => {
  it("keeps npm package metadata stable", () => {
    const pkg = record(packageJson)

    expect(pkg.name).toBe("@guataiba/paper7")
    expect(pkg.version).toBe("0.6.0-beta.0")
    expect(pkg.type).toBe("module")
  })

  it("publishes prebuilt dist only", () => {
    const pkg = record(packageJson)
    const bin = record(pkg.bin)

    expect(pkg.main).toBe("dist/cli.js")
    expect(bin.paper7).toBe("dist/cli.js")
    expect(pkg.files).toEqual(["dist/"])
    expect(pkg.type).toBe("module")
  })

  it("has no install-time hooks", () => {
    const scripts = record(record(packageJson).scripts)

    expect(scripts.preinstall).toBeUndefined()
    expect(scripts.install).toBeUndefined()
    expect(scripts.postinstall).toBeUndefined()
    expect(scripts.prepare).toBeUndefined()
  })

  it("keeps runtime deps small and shell-free", () => {
    const pkg = record(packageJson)
    const dependencies = Object.keys(stringRecord(pkg.dependencies)).sort()
    const bin = String(record(pkg.bin).paper7)

    expect(dependencies).toEqual(["@effect/platform-node", "effect"])
    expect(bin).toMatch(/^dist\//)
    expect(readText("src/cli.ts")).not.toMatch(/child_process|spawn\(|exec\(/)
  })
})
