import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests run against a real, DISPOSABLE PostgreSQL database that has been
// migrated with `npm run db:migrate`. They TRUNCATE tables, so never point them at shared data.
// They fail (not skip) when DATABASE_URL is missing.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    globalSetup: ["./src/test/integration-global-setup.ts"]
  }
});
