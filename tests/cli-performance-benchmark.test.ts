import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  buildCliPerfPlan,
  renderHyperfineArgs,
  seedCachedPaper,
} from "../src/cliPerformanceBenchmark.js"

describe("buildCliPerfPlan", () => {
  it.effect("includes startup --version for local built and bun variants", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/tmp/paper7-cache" })

      const labels = plan.commands.map((c) => c.label)
      expect(labels).toContain("local-built--startup-version")
      expect(labels).toContain("local-bun--startup-version")
      expect(plan.commands).toHaveLength(14)
    }))

  it.effect("includes cached get for local built and bun variants", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/tmp/paper7-cache" })

      const labels = plan.commands.map((c) => c.label)
      expect(labels).toContain("local-built--cached-get-2401.04088")
      expect(labels).toContain("local-bun--cached-get-2401.04088")

      const cachedGetCommands = plan.commands.filter((c) => c.label.includes("cached-get"))
      for (const cmd of cachedGetCommands) {
        expect(cmd.command).toContain("env HOME=/tmp/paper7-cache")
        expect(cmd.command).toContain("get 2401.04088 --detailed")
      }
    }))

  it.effect("includes cache list for local built and bun variants", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/tmp/paper7-cache" })

      const labels = plan.commands.map((c) => c.label)
      expect(labels).toContain("local-built--cache-list")
      expect(labels).toContain("local-bun--cache-list")

      const listCommands = plan.commands.filter((c) => c.label.includes("cache-list"))
      for (const cmd of listCommands) {
        expect(cmd.command).toContain("env HOME=/tmp/paper7-cache")
        expect(cmd.command).toContain("list")
      }

      expect(plan.commands).toHaveLength(14)
    }))

  it.effect("includes arxiv search cold and warm for local built and bun variants", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/tmp/paper7-cache" })

      const labels = plan.commands.map((c) => c.label)
      expect(labels).toContain("local-built--arxiv-search-cold-mixture-of-experts")
      expect(labels).toContain("local-bun--arxiv-search-cold-mixture-of-experts")
      expect(labels).toContain("local-built--arxiv-search-warm-mixture-of-experts")
      expect(labels).toContain("local-bun--arxiv-search-warm-mixture-of-experts")

      const coldCommands = plan.commands.filter((c) => c.label.includes("arxiv-search-cold"))
      for (const cmd of coldCommands) {
        expect(cmd.command).toContain("env HOME=/tmp/paper7-cache")
        expect(cmd.command).toContain("--no-cache")
      }

      const warmCommands = plan.commands.filter((c) => c.label.includes("arxiv-search-warm"))
      for (const cmd of warmCommands) {
        expect(cmd.command).toContain("env HOME=/tmp/paper7-cache")
        expect(cmd.command).not.toContain("--no-cache")
      }
    }))

  it.effect("includes pubmed search cold and warm for local built and bun variants", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/tmp/paper7-cache" })

      const labels = plan.commands.map((c) => c.label)
      expect(labels).toContain("local-built--pubmed-search-cold-heart-failure")
      expect(labels).toContain("local-bun--pubmed-search-cold-heart-failure")
      expect(labels).toContain("local-built--pubmed-search-warm-heart-failure")
      expect(labels).toContain("local-bun--pubmed-search-warm-heart-failure")

      const coldCommands = plan.commands.filter((c) => c.label.includes("pubmed-search-cold"))
      for (const cmd of coldCommands) {
        expect(cmd.command).toContain("env HOME=/tmp/paper7-cache")
        expect(cmd.command).toContain("--no-cache")
      }

      const warmCommands = plan.commands.filter((c) => c.label.includes("pubmed-search-warm"))
      for (const cmd of warmCommands) {
        expect(cmd.command).toContain("env HOME=/tmp/paper7-cache")
        expect(cmd.command).not.toContain("--no-cache")
      }
    }))

  it.effect("omits installed baseline when no path provided", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/tmp/paper7-cache" })

      const labels = plan.commands.map((c) => c.label)
      expect(labels).not.toContain("installed--startup-version")
      expect(labels).not.toContain("installed--cached-get-2401.04088")
      expect(labels).not.toContain("installed--cache-list")
      expect(labels).not.toContain("installed--pubmed-search-cold-heart-failure")
      expect(labels).not.toContain("installed--pubmed-search-warm-heart-failure")
    }))

    it.effect("includes installed baseline when installedPaper7 provided", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/tmp/paper7-cache", installedPaper7: "/usr/local/bin/paper7" })

      const labels = plan.commands.map((c) => c.label)
      expect(labels).toContain("installed--startup-version")
      expect(labels).toContain("installed--cached-get-2401.04088")
      expect(labels).toContain("installed--cache-list")
      expect(labels).toContain("installed--arxiv-search-cold-mixture-of-experts")
      expect(labels).toContain("installed--arxiv-search-warm-mixture-of-experts")
      expect(labels).toContain("installed--pubmed-search-cold-heart-failure")
      expect(labels).toContain("installed--pubmed-search-warm-heart-failure")

      const installedCommands = plan.commands.filter((c) => c.label.startsWith("installed"))
      for (const cmd of installedCommands) {
        expect(cmd.command).toContain("/usr/local/bin/paper7")
      }

      const installedCold = installedCommands.filter((c) => c.label.includes("-search-cold"))
      for (const cmd of installedCold) {
        expect(cmd.command).not.toContain("--no-cache")
      }

      expect(plan.commands).toHaveLength(21)
    }))

  it.effect("sets HOME env for cached get, cache list, and arxiv search commands", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/custom/home" })

      const cacheHomeCommands = plan.commands.filter((c) =>
        c.label.includes("cached-get") ||
        c.label.includes("cache-list") ||
        c.label.includes("arxiv-search") ||
        c.label.includes("pubmed-search")
      )
      for (const cmd of cacheHomeCommands) {
        expect(cmd.command).toContain("env HOME=/custom/home")
      }
    }))

  it.effect("does not set HOME env for startup commands", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/custom/home" })

      const startup = plan.commands.filter((c) => c.label.includes("startup-version"))
      for (const cmd of startup) {
        expect(cmd.command).not.toContain("env HOME=")
      }
    }))

  it.effect("does not include --no-cache for cached get commands", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/tmp/paper7-cache" })

      const cachedGetCommands = plan.commands.filter((c) => c.label.includes("cached-get"))
      for (const cmd of cachedGetCommands) {
        expect(cmd.command).not.toContain("--no-cache")
      }
    }))

  it.effect("includes --no-cache only for search cold commands", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/tmp/paper7-cache" })

      const coldCommands = plan.commands.filter((c) => c.label.includes("-search-cold"))
      for (const cmd of coldCommands) {
        expect(cmd.command).toContain("--no-cache")
      }

      const warmCommands = plan.commands.filter((c) => c.label.includes("-search-warm"))
      for (const cmd of warmCommands) {
        expect(cmd.command).not.toContain("--no-cache")
      }
    }))
})

describe("renderHyperfineArgs", () => {
  it.effect("renders command-name and command pairs", () =>
    Effect.gen(function* () {
      const plan = buildCliPerfPlan({ cacheHome: "/tmp/paper7-cache" })
      const args = renderHyperfineArgs(plan)

      expect(args).toContain("--command-name")

      const labelIndices = args
        .map((arg, index) => ({ arg, index }))
        .filter(({ arg }) => arg === "--command-name")
        .map(({ index }) => index)

      expect(labelIndices.length).toBe(plan.commands.length)

      for (const index of labelIndices) {
        const label = args[index + 1]
        const command = args[index + 2]
        const matching = plan.commands.find((c) => c.label === label)
        expect(matching).toBeDefined()
        expect(matching?.command).toBe(command)
      }
    }))
})

describe("seedCachedPaper", () => {
  it.effect("writes paper.md and meta.json fixture to temp cache", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => import("node:os").then((os) => os.tmpdir()))
      const cacheHome = `${tmp}/paper7-seed-test-${Date.now()}`
      yield* seedCachedPaper(cacheHome)

      const fs = yield* Effect.promise(() => import("node:fs/promises"))
      const paperContent = yield* Effect.promise(() =>
        fs.readFile(`${cacheHome}/.paper7/cache/2401.04088/paper.md`, { encoding: "utf8" })
      )
      const metaContent = yield* Effect.promise(() =>
        fs.readFile(`${cacheHome}/.paper7/cache/2401.04088/meta.json`, { encoding: "utf8" })
      )

      expect(paperContent).toContain("Benchmark Fixture Paper")
      expect(paperContent).toContain("Authors:** Ada Lovelace, Grace Hopper")

      const meta = JSON.parse(metaContent)
      expect(meta.id).toBe("2401.04088")
      expect(meta.title).toBe("Benchmark Fixture Paper")
      expect(meta.authors).toBe("Ada Lovelace, Grace Hopper")
      expect(meta.url).toBe("https://arxiv.org/abs/2401.04088")
    }))
})
