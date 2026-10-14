# Personal content input/output management

Openworks captures personal material, processes it into reusable content and prepares
outputs. Research is one use case alongside reading, collecting, organizing and
writing. Existing research-named tables, routes, MCP tools and project lifecycles stay
compatible; this change does not rename persisted data or imply a migration.

See the [Product comparison and roadmap](/docs/product-comparison/) for the public
product references behind these boundaries and the capabilities still to build.

## Module boundaries

`packages/domain/src/content/` contains plain TypeScript, with no Node, browser,
Convex or provider SDK dependencies:

- `contracts.ts`: `ContentSource` discriminated union, canonical `ContentList`, and
  separate `InputAdapter<T>`, `ProcessingAdapter`, `OutputAdapter<T>` contracts.
  `ContentAdapter<TInput, TOutput>` unifies their `stage` discriminants for exhaustive
  switching without a shared parent class.
- `input.ts`: text/link normalization and paper/screenshot adapters. Input references
  are preserved separately from working text. Empty text-only inputs, missing locators
  and duplicate IDs fail; sources without supplied text remain reference-only.
- `processing.ts`: injected text transforms preserve identity and original source,
  append processing metadata, and skip reference-only records. This is not a model
  implementation or an assertion that a model's output is true. Non-string results,
  including Promises from accidentally asynchronous transforms, are rejected.
- `output.ts`: Notion export plans and portable feed records. Output kind is a
  discriminated union. Preparing data performs no network request or publication.

These are capture/export-preparation contracts. They do not yet model persisted
revision IDs, stale-write checks, approval state or cryptographic source versions.
They must not replace a persistence layer that enforces those separate guarantees.

Lists and their nested source/processing records are copied and frozen at boundaries.
Order is preserved; duplicate IDs are rejected rather than silently overwriting
content. Canonical lists are validated again when processing or preparing an export,
including direct JavaScript callers: malformed fields, sparse lists, unsupported
source kinds and completeness flags that contradict source evidence are rejected.
Completeness describes the availability of original source text, not whether a
transform's resulting working text is empty. It does not verify the source's claims.
Processing is synchronous; callers must supply side-effect-free transforms.
The contract cannot enforce the purity of an injected callback. A caller that
needs asynchronous model work, storage, retries or transport must implement that
orchestration outside the shared domain package.

`scripts/content-input.mts` bridges existing intake jobs into these contracts.
`scripts/worker.mts` uses that bridge before prompt construction, explicitly marking
reference-only inputs so a locator is not presented as already-read content. Existing
job behavior, worker ownership and storage stay compatible. The remainder of the
legacy prompt builder is intentionally still in the worker; this is an incremental
boundary extraction, not a claim that the entire worker has been decomposed.

## Capability matrix

| Boundary | Implemented here | Separate or not yet implemented |
| --- | --- | --- |
| Screenshot input | Image locator and optional caller-supplied OCR text; preserves multiple screenshots from jobs | OCR execution, durable image snapshots, verification of OCR accuracy |
| Paper input | Reference plus optional supplied text; absence remains explicit | Full-text retrieval stays in the existing worker; adapter does not prove that supplied text is complete |
| Processing | Pure injected text transform; source and operation history preserved | Model quality evaluation, claim verification, asynchronous processor orchestration |
| Notion output | Destination-specific export plan with canonical contents | Direct Notion API transport, API payload conversion, authorization and live publication |
| Feed output | Portable ordered records with plain `content_text`, source evidence, completeness and processing history | Hosted endpoint, RSS/XML or JSON Feed standard serialization, access control and publication |
| Existing outputs | Current digest, summaries, project artifacts and suggestions remain available | Migration of every legacy output path to the new adapters |
| Video | No video adapter | Scene planning, rendering, rights review and export |

Source text, URLs, titles and model results remain untrusted. A locator is not
permission to read or publish. Consumers must validate transport URLs, escape text
for their target format, apply their owner/access checks and obtain destination
permissions before transmitting material. The feed record is internal export data,
not a promise of conformance to an external feed specification.

## Example

```ts
import { paperInput, textProcessor, feedOutput } from "@openworks/domain";

const input = paperInput.capture({
  id: "reading-1", reference: "doi:example", text: "Supplied source text",
});
const processed = textProcessor("local", "trim", (item) => item.text.trim()).process(input);
const exportPlan = feedOutput("My reading").prepare(processed);
// The caller reviews, serializes and publishes this plan separately.
```

## Reproducible evidence

Run `pnpm install --frozen-lockfile`, `pnpm typecheck` and `pnpm test`. The dedicated
content and legacy-job bridge suites exercise source preservation, missing evidence,
multiple images, duplicate IDs, unknown kinds, empty lists, isolation, processing
failures and output preparation. They use synthetic local fixtures; no provider,
Notion account, live feed or video render is exercised.

`pnpm benchmark:content` runs the same capture → transform → feed preparation path
for 1, 100 and 1,000 records, with warmups and repeated samples. Its JSON output
includes runtime, sample sizes, p50/p95 elapsed time, record count and serialized
output size. Timing is machine-dependent overhead for these pure adapters, not model
latency, a reliability percentage, a baseline improvement or a SOTA comparison.
The sample is `docs/benchmarks/content-pipeline.json`; it also asserts record count,
unique IDs, stable order, unchanged source text, expected transformed text and retained
processing metadata. Repository before/after checks and their limits are recorded in
`docs/benchmarks/verification.md` and `docs/benchmarks/verification.json`.
