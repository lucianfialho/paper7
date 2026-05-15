import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Ar5ivTimeoutError, makeAr5ivClient } from "../src/ar5iv.js"

describe("ar5iv timeout error", () => {
  it.effect("includes the PAPER7_TIMEOUT hint so users know how to extend the budget", () =>
    Effect.gen(function*() {
      const client = makeAr5ivClient({
        timeoutMs: 1,
        retries: 0,
        fetchImpl: () => {
          const err = new Error("aborted")
          err.name = "AbortError"
          return Promise.reject(err)
        },
      })

      const result = yield* client.getHtml("2210.03629").pipe(
        Effect.catchTag("Ar5ivTimeoutError", (error) => Effect.succeed(error))
      )

      expect(result).toBeInstanceOf(Ar5ivTimeoutError)
      expect(result.message).toContain("ar5iv request timed out after")
      expect(result.message).toContain("PAPER7_TIMEOUT")
    }))
})
