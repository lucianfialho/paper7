import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { run, opencode } from "@ai-hero/sandcastle"
import { docker } from "@ai-hero/sandcastle/sandboxes/docker"

const OUTER_ITERATIONS = 10
const AGENT_ITERATIONS = 100
const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>"
const DOCKER_IMAGE_NAME = "sandcastle:paper7"
const DOCKERFILE_HASH_LABEL = "paper7.sandcastle.dockerfile-sha256"
const DOCKERFILE = join(process.cwd(), ".sandcastle", "Dockerfile")
const COMPLETED_DIR = join(process.cwd(), ".sandcastle", "completed")
const PLAN_PROMPT_FILE = ".sandcastle/plan-prompt.md"
const MERGE_PROMPT_FILE = ".sandcastle/merge-prompt.md"
const HOST_OPENCODE_SHARE_DIR = join(process.env.HOME ?? "", ".local", "share", "opencode")
const HOST_OPENCODE_CONFIG_DIR = join(process.env.HOME ?? "", ".config", "opencode")
const ISSUE_ROOT_CANDIDATES = [
  join(process.cwd(), "issues"),
  join(
    process.cwd(),
    ".sandcastle",
    "worktrees",
    "sandcastle-issue-001-npm-cli-skeleton",
    "issues"
  ),
]

type Issue = {
  readonly id: string
  readonly title: string
  readonly file: string
  readonly body: string
}

type OpenCodeState = {
  readonly root: string
  readonly shareDir: string
  readonly configDir: string
}

const git = (args: readonly string[]): string =>
  execFileSync("git", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const dockerImageLabel = (label: string): string | undefined => {
  try {
    const value = execFileSync(
      "docker",
      ["image", "inspect", "--format", `{{ index .Config.Labels "${label}" }}`, DOCKER_IMAGE_NAME],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim()
    return value.length > 0 && value !== "<no value>" ? value : undefined
  } catch {
    return undefined
  }
}

const ensureDockerImage = (): void => {
  if (!existsSync(DOCKERFILE)) {
    throw new Error(`Missing ${DOCKERFILE}; cannot build ${DOCKER_IMAGE_NAME}`)
  }

  const dockerfileHash = createHash("sha256")
    .update(readFileSync(DOCKERFILE))
    .digest("hex")
  if (dockerImageLabel(DOCKERFILE_HASH_LABEL) === dockerfileHash) return

  console.log(`Building Docker image ${DOCKER_IMAGE_NAME}...`)
  execFileSync(
    "docker",
    [
      "build",
      "--label",
      `${DOCKERFILE_HASH_LABEL}=${dockerfileHash}`,
      "-t",
      DOCKER_IMAGE_NAME,
      "-f",
      DOCKERFILE,
      process.cwd(),
    ],
    { stdio: "inherit" }
  )
}

const findIssueRoot = (): string => {
  const issueRoot = ISSUE_ROOT_CANDIDATES.find((candidate) => existsSync(candidate))
  if (issueRoot !== undefined) return issueRoot
  throw new Error("No issues directory found for sandcastle run")
}

const loadIssues = (): readonly Issue[] => {
  const issueRoot = findIssueRoot()

  return readdirSync(issueRoot)
    .filter((file) => /^\d{3}-.+\.md$/.test(file))
    .sort()
    .map((file) => {
      const body = readFileSync(join(issueRoot, file), "utf8")
      const heading = body.split("\n").find((line) => line.startsWith("# "))
      const fallbackTitle = basename(file, ".md").replace(/^\d{3}-/, "")
      const title = heading?.replace(/^#\s+\d{3}:\s*/, "").trim() || fallbackTitle
      return { id: file.slice(0, 3), title, file, body }
    })
}

const completionMarker = (issue: Issue): string => join(COMPLETED_DIR, issue.id)

const isIssueComplete = (issue: Issue): boolean => existsSync(completionMarker(issue))

const markIssueComplete = (issue: Issue): void => {
  mkdirSync(COMPLETED_DIR, { recursive: true })
  writeFileSync(completionMarker(issue), `${issue.file}\n`)
}

const isMergedIntoHead = (branch: string): boolean => {
  try {
    git(["merge-base", "--is-ancestor", branch, "HEAD"])
    return true
  } catch {
    return false
  }
}

const createOpenCodeState = (): OpenCodeState => {
  const root = mkdtempSync(join(tmpdir(), "paper7-opencode-"))
  const shareDir = join(root, "share", "opencode")
  const configDir = join(root, "config", "opencode")

  mkdirSync(shareDir, { recursive: true })
  for (const file of ["auth.json", "mcp-auth.json"]) {
    const source = join(HOST_OPENCODE_SHARE_DIR, file)
    if (existsSync(source)) copyFileSync(source, join(shareDir, file))
  }

  if (existsSync(HOST_OPENCODE_CONFIG_DIR)) {
    cpSync(HOST_OPENCODE_CONFIG_DIR, configDir, {
      recursive: true,
      filter: (source) => !source.includes("/node_modules/") && !source.endsWith("/node_modules"),
    })
  }

  return { root, shareDir, configDir }
}

const slugFor = (issue: Issue): string =>
  issue.file
    .replace(/^\d{3}-/, "")
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

const agent = opencode("openai/gpt-5.5")
const openCodeState = createOpenCodeState()
const sandbox = docker({
  imageName: DOCKER_IMAGE_NAME,
  mounts: [
    {
      hostPath: openCodeState.shareDir,
      sandboxPath: "/home/agent/.local/share/opencode",
    },
    {
      hostPath: openCodeState.configDir,
      sandboxPath: "/home/agent/.config/opencode",
    },
  ],
})

ensureDockerImage()

try {
for (let iteration = 1; iteration <= OUTER_ITERATIONS; iteration += 1) {
  console.log(`\n=== Sandcastle iteration ${iteration}/${OUTER_ITERATIONS} ===\n`)

  const issue = loadIssues().find((candidate) => !isIssueComplete(candidate))

  if (issue === undefined) {
    console.log("No remaining issues.")
    break
  }

  const branch = `sandcastle/issue-${issue.id}-${slugFor(issue)}`

  await run({
    agent,
    sandbox,
    name: "planner",
    branchStrategy: { type: "branch", branch },
    promptFile: PLAN_PROMPT_FILE,
    promptArgs: {
      ISSUE_FILE: issue.file,
      ISSUE_BODY: issue.body,
      COMPLETION_SIGNAL,
    },
    maxIterations: AGENT_ITERATIONS,
    completionSignal: COMPLETION_SIGNAL,
  })

  console.log(`${issue.id}: ${issue.title} -> ${branch}`)

  await run({
    agent,
    sandbox,
    name: "merger",
    promptFile: MERGE_PROMPT_FILE,
    promptArgs: {
      ISSUE_FILE: issue.file,
      ISSUE_BODY: issue.body,
      BRANCH: branch,
      COMPLETION_SIGNAL,
    },
    maxIterations: AGENT_ITERATIONS,
    completionSignal: COMPLETION_SIGNAL,
  })

  if (!isMergedIntoHead(branch)) {
    throw new Error(`Merger did not merge ${branch} into HEAD.`)
  }

  markIssueComplete(issue)
  console.log("Merged completed branches.")
}
} finally {
  rmSync(openCodeState.root, { recursive: true, force: true })
}
