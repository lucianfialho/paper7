import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { CROSSREF_POLITE_POOL_EMAIL, makeCrossrefClient } from "../src/crossref.js"

describe("crossref metadata", () => {
  it("uses CROSSREF_POLITE_POOL_EMAIL in request URL", async () => {
    let capturedUrl: string | undefined

    const fakeFetch = (url: string, _init: { readonly signal: AbortSignal }): Promise<Response> => {
      capturedUrl = String(url)
      return Promise.resolve(new Response("{}", { status: 200 }))
    }

    const client = makeCrossrefClient({ fetchImpl: fakeFetch })
    await client.get("10.5555/test").pipe(Effect.runPromiseExit)

    expect(capturedUrl).toBeDefined()
    expect(capturedUrl).toContain(`mailto=${encodeURIComponent(CROSSREF_POLITE_POOL_EMAIL)}`)
    expect(capturedUrl).not.toContain("paper7@example.com")
  })

  it("exports a non-placeholder email", () => {
    expect(CROSSREF_POLITE_POOL_EMAIL).not.toBe("paper7@example.com")
    expect(CROSSREF_POLITE_POOL_EMAIL).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  })
})
