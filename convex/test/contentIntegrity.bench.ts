// Identical local read/modify/write workload for PR5 and the integrity candidate.
// This measures convex-test harness overhead, not deployed latency or quality.
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { anyApi } from "convex/server";
import { getDocumentSize } from "convex/values";
import { auth, withConvex } from "./harness.setup";
const api = anyApi;
for (const [kind, module, key, field] of [
  ["memo", "researchMemos", "memoSlug", "content"],
  ["section", "researchSections", "sectionSlug", "content"],
  ["tex", "researchTex", "texPath", "content"],
  ["experiment", "researchExperiments", "expSlug", "description"],
])
  it(`measures ${kind} read-modify-write`, async () => {
    const t = withConvex();
    const identity = { researchSlug: "synthetic-benchmark", [key!]: "sample" };
    await t.mutation(api[module!].save, { ...auth, ...identity, [field!]: "x".repeat(1024) });
    const samples: number[] = [];
    let versioned = false;
    for (let i = 0; i < 110; i++) {
      const start = performance.now();
      const row = await t.query(api[module!].get, { ...auth, ...identity });
      versioned = typeof row.revision === "number";
      await t.mutation(api[module!].save, {
        ...auth,
        ...identity,
        [field!]: `${i.toString().padStart(4, "0")}${"x".repeat(1020)}`,
        ...(versioned ? { expectedRevision: row.revision } : {}),
      });
      if (i >= 10) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const storage = await t.run(async (ctx) => {
      const tables = [module!, ...(versioned ? ["contentHeads", "contentRevisions", "contentRevisionChunks"] : [])];
      let documents = 0,
        bytes = 0;
      for (const table of tables)
        for (const row of await ctx.db.query(table as "researchMemos").collect()) {
          documents++;
          bytes += getDocumentSize(row);
        }
      return { documents, bytes };
    });
    const result = {
      kind,
      runtime: process.version,
      warmups: 10,
      samples: 100,
      textCodeUnits: 1024,
      p50Ms: samples[49],
      p95Ms: samples[94],
      storage,
      versioned,
    };
    if (!process.env.INTEGRITY_BENCH_OUTPUT)
      throw new Error("Set INTEGRITY_BENCH_OUTPUT to a local output filename prefix");
    writeFileSync(`${process.env.INTEGRITY_BENCH_OUTPUT}-${kind}.json`, JSON.stringify(result, null, 2) + "\n");
  }, 30_000);
