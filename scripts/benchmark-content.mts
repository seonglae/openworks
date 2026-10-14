import { performance } from "node:perf_hooks";
import { contentInput, feedOutput, textProcessor } from "@openworks/domain";

const warmups = 10;
const samples = 50;
const transform = textProcessor("benchmark", "trim", (item) => item.text.trim());
const output = feedOutput("synthetic benchmark");
const results = [1, 100, 1000].map((records) => {
  const inputs = Array.from({ length: records }, (_, i) => ({
    id: `synthetic-${i}`,
    title: `Item ${i}`,
    source: { kind: "text" as const, text: `  Synthetic fixture ${i}. No model calls.  ` },
  }));
  const run = () => output.prepare(transform.process(contentInput.capture(inputs)));
  for (let i = 0; i < warmups; i++) run();
  const timings: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    run();
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const result = run();
  const checks = {
    record_count: result.items.length === records,
    unique_ids: new Set(result.items.map((item) => item.id)).size === records,
    stable_order: result.items.every((item, index) => item.id === inputs[index].id),
    source_preserved: result.items.every(
      (item, index) => item.source.kind === "text" && item.source.text === inputs[index].source.text,
    ),
    expected_transform: result.items.every((item, index) => item.content_text === inputs[index].source.text.trim()),
    processing_preserved: result.items.every(
      (item) =>
        item.completeness === "text-available" &&
        item.processing.length === 1 &&
        item.processing[0].processor === "benchmark" &&
        item.processing[0].operation === "trim",
    ),
  };
  if (!Object.values(checks).every(Boolean)) throw new Error("benchmark invariant failed");
  return {
    records,
    samples,
    warmups,
    p50_ms: timings[Math.ceil(samples * 0.5) - 1],
    p95_ms: timings[Math.ceil(samples * 0.95) - 1],
    output_records: result.items.length,
    output_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
    invariant_checks: checks,
  };
});
console.log(
  JSON.stringify(
    {
      benchmark: "content-pipeline",
      fixture: "synthetic-v1",
      runtime: process.version,
      platform: `${process.platform}-${process.arch}`,
      scope: "capture -> trim -> feed preparation; no network/model/rendering",
      limitations: "Local timing only. No baseline, model quality, publication or SOTA comparison.",
      results,
    },
    null,
    2,
  ),
);
