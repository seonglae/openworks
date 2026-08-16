// Shared convex-test bootstrap. Named with two dots on purpose: the Convex
// bundler skips any filename containing more than one dot, so this never gets
// pushed to the deployment (a plain `setup.ts` here is pushed and dies on
// `import.meta.glob`). Vitest's include is `test/**/*.test.ts`, so it is not
// collected as a test file either.

import { convexTest } from "convex-test";
import schema from "../schema";

// Typed inline rather than through vite/client: vite is a browser-only
// devDependency and does not resolve from convex/. The glob is resolved
// relative to this file, which is why it has to live inside convex/.
const modules = (import.meta as unknown as { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob(
  "../**/*.ts",
);

export const withConvex = () => convexTest(schema, modules);

// An unconfigured deployment is closed, so the suite has to authenticate like
// any other caller. It used to pass nothing and rely on the gate being open,
// which meant no test ever exercised the gate at all.
process.env.OPENWORKS_SERVICE_KEY ??= "test-service-key";
export const auth = { serviceKey: process.env.OPENWORKS_SERVICE_KEY };
