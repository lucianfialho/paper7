import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: ["**/.sandcastle/**", "**/node_modules/**", "**/dist/**"],
  },
})
