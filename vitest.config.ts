import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several CLI integration tests intentionally vary process-level machine
    // configuration. Forks keep those environments isolated across files.
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["packages/kernel/src/**/*.ts", "packages/adapters/src/**/*.ts"],
      thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
    },
  },
});
