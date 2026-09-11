import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    include: ["tests/recovery/**/*.test.ts"],
  },
});
