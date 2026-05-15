const TIMEOUT_ENV_VAR = "PAPER7_TIMEOUT"

export const resolveTimeoutMs = (defaultMs: number): number => {
  const raw = process.env[TIMEOUT_ENV_VAR]
  if (raw === undefined || raw.trim() === "") return defaultMs
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) return defaultMs
  return parsed
}

export const timeoutHint = `Hint: set ${TIMEOUT_ENV_VAR}=<ms> to extend the budget.`
