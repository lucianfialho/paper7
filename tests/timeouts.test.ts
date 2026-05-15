import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { resolveTimeoutMs, timeoutHint } from "../src/timeouts.js"

describe("resolveTimeoutMs", () => {
  const original = process.env.PAPER7_TIMEOUT

  beforeEach(() => {
    delete process.env.PAPER7_TIMEOUT
  })

  afterEach(() => {
    if (original === undefined) delete process.env.PAPER7_TIMEOUT
    else process.env.PAPER7_TIMEOUT = original
  })

  it("returns the default when PAPER7_TIMEOUT is unset", () => {
    expect(resolveTimeoutMs(20_000)).toBe(20_000)
  })

  it("returns the parsed env value when set to a positive integer", () => {
    process.env.PAPER7_TIMEOUT = "30000"
    expect(resolveTimeoutMs(20_000)).toBe(30_000)
  })

  it("accepts zero", () => {
    process.env.PAPER7_TIMEOUT = "0"
    expect(resolveTimeoutMs(20_000)).toBe(0)
  })

  it("returns the default when the env value is non-numeric", () => {
    process.env.PAPER7_TIMEOUT = "abc"
    expect(resolveTimeoutMs(20_000)).toBe(20_000)
  })

  it("returns the default when the env value is the empty string", () => {
    process.env.PAPER7_TIMEOUT = ""
    expect(resolveTimeoutMs(20_000)).toBe(20_000)
  })

  it("returns the default when the env value is whitespace", () => {
    process.env.PAPER7_TIMEOUT = "   "
    expect(resolveTimeoutMs(20_000)).toBe(20_000)
  })

  it("returns the default when the env value is negative", () => {
    process.env.PAPER7_TIMEOUT = "-5"
    expect(resolveTimeoutMs(20_000)).toBe(20_000)
  })

  it("returns the default when the env value is a float", () => {
    process.env.PAPER7_TIMEOUT = "3.5"
    expect(resolveTimeoutMs(20_000)).toBe(20_000)
  })
})

describe("timeoutHint", () => {
  it("mentions PAPER7_TIMEOUT so users know which env var to set", () => {
    expect(timeoutHint).toContain("PAPER7_TIMEOUT")
  })
})
