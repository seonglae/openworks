# Persisted content integrity verification

This public-only follow-on concerns personal content Input/Processing/Output management.
It is stacked on PR #5, not substituted for the recovered adapter checkpoint.

## Exact comparison and checks

- Baseline: commit `f57037ff3107203a668e452a190b46bc23e218d5`, tree `9862a9b065d8e98c42fa934538611274ff7aae3a`.
- That checkpoint passed 1,123 tests in 44 files and exact-head [CI](https://github.com/seonglae/openworks/actions/runs/38512975888).
- Candidate: **1315/1315 tests in 52 files**, full typecheck, app build and site/demo build passed; 18 static site routes excluding demo.
- Frozen install passed with optional CUDA download skipped. Node 24.19.0 / pnpm 11.25.0 locally; declared pnpm 11.15.1 and CI Node 22 remain unchanged. No GPU/live inference claim.
- Lockfile SHA256: `e09f38022aa46a4b96c1fad16bef7b5a6fb8cbf46e46cb2634a7103f499af74d`.
- Source binding: 291 files in `integrity-source-manifest.json`, digest `bd6e1c72257dc6b6bc9ad964bd38f08f11626d92a0049c03bf6b7ebe4cfbc9cf`. Evidence files are excluded to avoid a recursive manifest.

The newly defined eight-case fixture passes **0/8 → 8/8** against the detached PR5
backend and this candidate. Its cases cover workspace dispatch, queued config/source
pins, upsert state audit, retained human history, stale writes, immutable deletion
history, unclaimed-run rejection and large legacy first-save preservation. Both
outcomes, including all eight baseline failures, are retained in normalized JSON.
These are not the unavailable October 13 cases, and their old timing/8-of-8 claim
is not reused. This small acceptance fixture is not an overall reliability percentage.

Named-test-instance comparison retains 1120 prior identities,
intentionally replaces three obsolete behavior assertions, and adds 195
new/replacement instances (net +192). Existing CRUD fixtures now pass original
read tokens and accept additive revision fields. A preexisting oversized cascade
fixture was corrected to multiple valid sub-1 MiB documents. Increased test count
measures coverage, not product quality or model accuracy.

## Same-workload cost, not speedup

Each kind starts in a fresh in-memory convex-test database with 1 KiB ASCII text,
then performs 10 warmups and 100 measured read/modify/write samples. Baseline and
candidate resolve the domain package to their own source tree using the same frozen
dependency versions. Candidate writes supply the revision from that sample's read.
The reported storage is Convex document-size accounting after 110 real updates,
not a cloud bill or index/engine allocation measurement.

| Kind       | Before p50 ms | After p50 ms | Before p95 ms | After p95 ms | Before bytes | After bytes |
| ---------- | ------------: | -----------: | ------------: | -----------: | -----------: | ----------: |
| memo       |         0.370 |        1.577 |         0.987 |        5.400 |        1,200 |     308,916 |
| section    |         0.411 |        1.219 |         0.835 |        2.355 |        1,220 |     314,381 |
| tex        |         0.393 |        1.109 |         3.102 |        2.047 |        1,185 |     304,681 |
| experiment |         0.347 |        1.135 |         0.810 |        2.613 |        1,218 |     314,718 |

The baseline retains 1 live document; the candidate retains 224 documents: 1 live row,
1 head, 111 immutable revision records and 111 chunk records. History increases
latency and retained storage. This shared-host single-run timing is not a controlled
production benchmark and gives no model, network, user-edit-effort or SOTA result.
There is no automatic compression/retention policy in this change.

The earlier pure-adapter benchmark in `content-pipeline.json` still has no equivalent
old-main baseline. This new persisted CRUD workload does not fill that gap.

## Boundaries and remaining work

Strict transaction-limit fixtures preserve entire 900,000-character valid control-text
legacy records across first save/delete for all four types, and first section/TeX
forks with both source and target large. They also cover stale and concurrent tokens,
no-op identity, tombstone/recreate behavior, exact input/output attribution, invalid
snapshot reconstruction, state inference and bounded binary-history cleanup.
Codec-only surrogate tests are not a claim that Convex accepts invalid Unicode.
Direct Convex/binary storage retains special numbers; existing JSON MCP numeric
transport does not preserve NaN/infinities/negative zero exactly.

Whole-project deletion remains destructive and starts a new lifecycle if the slug
is later reused; numeric revision tokens are not global incarnation IDs. Abandoned
researchPhaseRuns recovery is not added; the agentRuns reaper is unchanged. The
owner/service-key gate remains. Restore UI, source-byte/image capture, OCR, verified
claim spans, public sharing, direct Notion publication, hosted feeds and video/provider
evaluations remain future work. No provider call, merge or manual deployment was run.

Reproduce the source checks using the commands in `docs/content-integrity.md`.
Raw logs remain in the private recovery evidence; public JSON contains test names,
outcomes and counts without local absolute paths. Benchmark JSON retains raw local
sample summaries and storage counts. The final PR CI must verify its exact head.
