# Openworks personal content boundary verification

Measured on 2026-10-14 using public repository source and synthetic fixtures.

## Exact sources and environment

- Before: original main commit `8f1c786ef4d38e759f0162f4f336ee32f38d1358`; clean baseline worktree.
- After: uncommitted local candidate based on that commit. The exact tested source is identified by SHA-256 manifest `144d20d615a3b05a84f63f003e325536335c28558bde65294fbc87776966cf30` in `source-manifest.json` (benchmark/evidence files are excluded to avoid self-reference).
- Linux x64, Node v24.19.0, pnpm 11.25.0. CI specifies Node 22 and the repository declares pnpm 11.15.1; this run does not certify those other runtimes.
- Both frozen installs passed and the dependency lockfile remained byte-identical. The initial baseline install hit a transient ONNX GPU download proxy timeout; retry succeeded. No actual inference ran.
- Home configuration is read-only here; installs used a temporary store, and Astro ran with telemetry disabled plus a writable temporary config directory.

## Before and after

| Check | Original main | Local candidate |
| --- | --- | --- |
| Full test files | 42 passing | 44 passing |
| Full test cases | 1037/1037 passing | 1123/1123 passing |
| Typecheck, including tests and Astro | Passed | Passed |
| Application production build | Passed | Passed |
| Site and bundled demo build | Passed | Passed |
| Static site routes, excluding the demo | 15 | 17 |
| Shared content-adapter microbenchmark | No equivalent implementation | Measured below |

All 1037 baseline test identities remain and pass. 86 additional cases cover the new domain/worker bridge and public documentation; no baseline test identity was removed. Test count is coverage of new checks, not measured model accuracy or a product-reliability percentage. Normalized per-test outcomes are saved in `baseline-tests.json` and `candidate-tests.json`.

## What the additional checks establish

The separate Input, Processing and Output contracts are also exposed as a stage-discriminated `ContentAdapter` union; an exhaustive switch is checked by TypeScript. The canonical list boundary validates direct callers as well as capture adapters. Tests exercise malformed titles/text/source and processing records, sparse lists, unsupported discriminants, duplicate IDs, source/completeness contradictions, unknown-property removal and payload-safe errors. A processor cannot export a Promise or other non-string result. Original source evidence, order and named processing steps survive valid transformations; reference-only material is not processed as read content.

Screenshot and paper adapters preserve source references and supplied text. The legacy-job bridge retains multiple screenshots. Output adapters prepare immutable Notion/feed plans without network transport. Documentation tests check the personal-content scope, comparison discoverability and resolving cross-links; the built comparison and content guides resolve locally.

## Adapter microbenchmark

Same synthetic fixture and capture → trim → feed preparation sequence, 10 warmups and 50 timed samples per size. No baseline adapter implementation exists, so these figures do not show an improvement over original main or another product.

| Records | p50 ms | p95 ms | Serialized output bytes |
| --- | --- | --- | --- |
| 1 | 0.0090 | 0.0287 | 314 |
| 100 | 0.2855 | 0.8563 | 26,315 |
| 1,000 | 3.0586 | 5.0669 | 266,615 |

Every size separately verifies record count, unique IDs, order, original text preservation, the expected trimmed result and processing metadata. `content-pipeline.json` contains unrounded timings and all invariant results. This is local pure-adapter overhead, not model latency or output-quality evidence, and other work on the host can affect timings.

## Remaining limits

- No live provider, OCR, Notion publication, hosted feed, video render, authentication or deployed backend was tested. The build-time demo uses synthetic fixtures. Credential-free application compilation does not establish that a configured live UI works.
- Both revisions retain pre-existing large-chunk and deprecated `markdown.smartypants` build warnings. Astro type diagnostics are 0 errors, 0 warnings and 0 hints.
- `site/og-card.html` has the corrected personal-content headline, but `site/public/og.png` is still the original asset. Chromium could not launch under this runtime's restrictions. Regenerate the 1200×630 image in a working browser before publication.
- Changes remain local and uncommitted; no PR, remote write, merge or deployment was performed.

The commands and environment are recorded in `verification.json`; sanitized typecheck and build logs are alongside it. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build:app`, `pnpm site:build` and `pnpm benchmark:content` in the intended publication environment before release.
