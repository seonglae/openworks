import { defineConfig } from "vitest/config";

// One runner for the whole workspace (`pnpm test`), split into projects because
// the tiers need different environments: plain node for the shared
// packages, Convex's edge runtime for backend handlers, and a DOM for React
// components. Tests live in `<module>/test` throughout.
export default defineConfig({
  test: {
    projects: [
      {
        // The CLI dispatch layer at the repo root. It had no project at all,
        // which is how a codex invocation that could not reach the network
        // stayed broken silently — nothing asserted the argv.
        test: {
          name: "root",
          root: "./",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "core",
          root: "./packages",
          include: ["*/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "convex",
          root: "./convex",
          include: ["test/**/*.test.ts"],
          // convex-test executes handlers in the same runtime Convex uses.
          environment: "edge-runtime",
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        test: {
          name: "site",
          root: "./site",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "browser",
          root: "./browser",
          include: ["test/**/*.test.{ts,tsx}"],
          environment: "happy-dom",
          setupFiles: ["./test/setup.ts"],
        },
      },
    ],
  },
});
