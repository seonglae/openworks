# Product comparison and content roadmap

Openworks is a personal content input/output manager. Its reusable unit is an ordered
`ContentList` moving through separate Input, Processing and Output contracts.
Reading, writing and research are use cases for this content loop. The current
integration is incremental; existing workflows do not all use these contracts yet.

This is a design comparison of documented capabilities, checked on 2026-10-14.
It is not a benchmark ranking, a claim of state-of-the-art quality or a claim that a
competitor lacks capabilities absent from the cited page. No competitor code, private
project implementation or user content is included.

## Comparator mapping

| Product | Documented emphasis | Lesson for Openworks | Evidence in this change | Remaining boundary |
| --- | --- | --- | --- | --- |
| [Notion](https://www.notion.com/help/duplicate-delete-and-restore-content) | Editable pages with recoverable version history | Keep source material recoverable; distinguish preparing an output from publishing it | Immutable in-memory snapshots and an explicit Notion export plan | Persisted revisions, restore UI, actual Notion transport and publication approval |
| [Readwise Reader](https://docs.readwise.io/reader/guides/ghostreader/global) | Library-wide answers with citations to source passages; configurable tool permissions | Carry source evidence through processing and exports, with separate read/write authority | Source union, completeness flag and processing history preserved through feed preparation | Verified passage locators, retrieval evaluation and source freshness |
| [Capacities](https://docs.capacities.io/reference/media-analysis) | Media analysis stores extracted information on reusable objects | Preserve image identity separately from supplied OCR and interpretation | Screenshot input retains its locator; the intake bridge retains every screenshot | OCR execution, durable image snapshots and OCR accuracy evaluation |
| [Obsidian](https://obsidian.md/) | Local plain-text Markdown ownership | Keep the core portable and independent of a provider SDK | Runtime-neutral contracts, plain data and portable feed preparation | Complete Markdown/media round-trip export and external-feed serialization |
| [NotebookLM / Gemini Notebook](https://support.google.com/gemininotebook/answer/16454555?hl=en) | Generates video overviews from notebook sources | Source-to-video alone is not a differentiator; test traceable revision-aware editing | Input evidence boundary and clearly marked reference-only material | Claim verification, script/scene lineage, rendering and video quality evaluation |
| [Descript](https://help.descript.com/getting-started/edit-like-a-doc) | Script edits update underlying media | Keep a script editable and tie derived scenes to its exact version | Processing preserves original input while appending an operation record | Script revisions, scene/timeline editing and selective rerendering |
| [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo/blob/main/README-en.md) | Open-source automated short-video pipeline | Evaluate rendering adapters before rebuilding commodity video assembly | Adapter separation leaves rendering outside the content core | Renderer integration, license review and matched content-quality evaluation |
| [Texonom](https://texonom.com/texonom) | URL-addressed concepts organized with hierarchy and knowledge links | Reuse stable knowledge identities across intake and output | Paper/link source identities are retained as opaque references | Taxonomy mapping, concept linking and an authorized import/export adapter |

## Implemented foundations and remaining work

Checked items are narrow Openworks boundaries covered by local tests, not equivalent
implementations of the products above. Preserving a source reference does not provide
passage citations, immutable in-memory data is not version history, and separating an
output adapter does not generate a video. Unchecked items are future work.

- [x] Prepare Notion export data independently, with no publication side effect.
- [x] Preserve source, text-availability and processing metadata through feed preparation.
- [x] Retain screenshot references separately from text and keep every supplied image.
- [x] Keep portable content data runtime-neutral, without provider SDK imports.
- [x] Record missing source text explicitly instead of presenting a locator as read evidence.
- [x] Preserve the original source while applying independently named processing steps.
- [x] Keep renderer concerns out of the input and processing contracts.
- [x] Keep source references unchanged through processing and output preparation.
- [ ] Persistent revision history, content restore and stale-write detection.
- [ ] Actual Notion publication, standards-compliant feed hosting and access checks.
- [ ] Source-byte snapshots, OCR execution and independently verified claim spans.
- [ ] Script/storyboard approval, renderer adapter, cost limit, cancellation and export.
- [ ] Live-provider, rendered-video and user-edit-effort evaluations.

## Screenshot-to-video use case

A person captures a complicated screenshot and wants a short explanatory video.

This is a proposed end-to-end workflow. Only the first capture boundary is currently
implemented; the evidence, script and video stages below remain roadmap work.

1. Input captures original image identity and optional supplied text. It must distinguish
   absent text from extracted text. A URL or image reference alone is not verified evidence.
2. Processing first locates corroborating sources, records claims with exact source spans,
   and prepares a brief and editable script. Each uncertain claim remains marked.
3. Output prepares a storyboard and render plan against an exact script revision. External
   upload, rendering and publication require separately authorized destinations and budgets.

The proposed lineage is `SourceAsset -> Claim -> ScriptRevision -> Scene -> RenderJob -> ExportArtifact`.
These additional records and video operations are a roadmap, not implemented by the
current adapters. A useful differentiation to test is whether a changed source can identify
affected claims and scenes, allowing a reviewer to repair only the affected outputs.
This is a hypothesis until measured against actual tools on the same corpus.

## Evaluation contract

Use a fixed public or synthetic corpus, the same input material and the same allowed
source access for every evaluated product. Record input count, source completeness,
source preservation, unsupported claims, useful output count, edit effort, latency and
total cost. Preserve failures and missing outputs in the denominator.

The current evidence is deliberately narrower: domain/bridge tests and a local adapter
microbenchmark, with no provider call, external publication or video render.
See [Content management](/docs/content-management/) and the recorded adapter
measurement at `docs/benchmarks/content-pipeline.json` in the source checkout.
Before/after repository checks must identify both exact source revisions and report
new tests separately from pre-existing tests; added tests are not a measured gain in
model accuracy or product reliability.
