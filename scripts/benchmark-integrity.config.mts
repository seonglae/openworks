import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@openworks/domain": new URL("../packages/domain/src/index.ts", import.meta.url).pathname } },
  test: {
    environment: "edge-runtime",
    include: ["convex/test/contentIntegrity.bench.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
