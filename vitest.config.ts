import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests only. They never touch a database or the network.
// Integration tests live in *.integration.test.ts and run via vitest.integration.config.ts.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // tsconfig keeps jsx: "preserve" for Next.js; tests that render components need it compiled.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"]
  }
});
