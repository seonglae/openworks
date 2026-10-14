# Content integrity

This guide covers durable content and processing records: persisted revisions,
stale-write checks, pinned agent inputs and audited state changes.

## Revisions and concurrent writes

Memos, sections, TeX and experiments retain immutable persisted snapshots. Separate
head and chunk tables leave the original content-table payloads backward compatible.
A live `get_*` or `list_*` result adds `revision` and optional `revisionId`.

- New content starts at revision 1. Unversioned legacy content reads as revision 0.
- First legacy save, delete or fork preserves its full prior snapshot as revision 0.
- Updates, deletion tombstones and recreations advance the same head monotonically within that content lifecycle.
  Deletion does not reset its token, preventing stale delete/recreate overwrites.
- Once a head exists, save/delete require `expectedRevision` from the caller’s read.
  Fork additionally checks `expectedSourceRevision` and records that exact source.
- A missing or stale token fails atomically. Do not automatically refresh it and
  resend an old edit. Read, reconcile and submit a deliberate new write.
- Same-content saves keep the exact stored revision ID and timestamp and emit no
  event. Changing only storage timestamps or database IDs does not define new content.

This intentionally changes blind-overwrite clients: upgrade MCP callers before
using these write paths. Initial creation and first unversioned adoption may omit
the token or use 0; a second concurrent legacy writer cannot overwrite the first.
Existing table, figure, venue and report tools are not yet revisioned.

`get_content_head` also reads deleted identities. `list_content_revisions` returns
at most 100 metadata records newest-first; pass the last version as `beforeVersion`
to page. `get_content_revision` reconstructs a full exact snapshot by its ID.
There is no mutation API for editing an old revision and no automatic restore UI;
a reviewed restore is a new save with the current read token.

## Large existing content

The versioned UTF-16-field binary codec preserves text code units exactly, including
valid control characters, BOMs and astral characters. Codec-only tests also cover
lone surrogate code units, but Convex does not accept unpaired-surrogate strings in
stored documents; that is not a database persistence claim. Keys are canonical;
arrays, nulls, booleans and Convex numeric special values are retained in binary
storage and direct Convex reads. The existing JSON MCP transport normalizes special
numbers (`NaN`/infinities to `null`, negative zero to zero); it is not a lossless
transport for those legacy numeric edge cases. Ordinary content text is unaffected. Snapshot bytes
are split into 128 KiB chunks, with a 3 MiB encoded-snapshot safety bound. This avoids
JSON’s sixfold expansion of control characters and never truncates legacy text.
Malformed, missing, extra or truncated chunks fail reconstruction explicitly.

Strict local transaction-limit tests exercise 900,000-character control-text
legacy first saves/deletes for all four content kinds, and first section/TeX forks
with both source and target near that size. They verify the complete original
snapshots, not excerpts. Convex currently documents 1 MiB per document and 16 MiB
per transaction read/write; production CPU, contention and throughput remain
separate constraints. [Convex limits](https://docs.convex.dev/production/state/limits).

Revision history increases stored bytes and write work; it grows with each real edit.
No automatic history compression, retention quota or pruning policy is added here.
Individual content deletion
retains its history. Explicit whole-project deletion remains permanent: its resumable,
bounded cascade removes heads, revisions, binary chunks and live rows. Size accounting
uses Convex’s document-size utility, including binary data. While deletion is in
progress, versioned content cannot be rewritten to reset its head. Back up before
whole-project deletion; immutable history is not a backup against that operation.
Reusing a slug after complete project deletion starts a new lifecycle. A numeric
revision alone is not a global incarnation token and can repeat across that reset;
old clients must discard their cached tokens and read the new project/content.

## Processing and output attribution

Global, project and workspace subscriptions all resolve against the event’s project.
Canonical config, trigger identity and exact source revision IDs are frozen when a
run is queued. State and comment events also preserve their event snapshots; text
is not squeezed into a lossy preview. Later source/config edits cannot substitute
new content into an old run. See [Agents](/docs/agents/) for configuration limits.

Derived content may name up to 32 distinct, existing, non-deleted source revisions
from the same project. Attributed outputs must match a running run’s exact queued
input set. An attributed comment must also match that run’s agent, target and venue.
Its immutable output snapshot records the run and sources. Claimed runs finish only
with an attributed comment or explicit `NO_ACTION`; an unclaimed/reaped run cannot
be marked successful. Legacy missing-snapshot rows cannot manufacture audited output.

These checks establish storage and attribution integrity, not factual correctness,
provider quality or permission to publish. Agent config and source text remain
untrusted prompt data. Live providers, OCR, direct Notion publishing, hosted feed
publishing and video generation were not exercised by these local tests.

## State audit and access

Server paths share kind-aware state validation, history and trigger handling. Direct
UI selection accepts any valid state; `advance` additionally enforces adjacency.
Inference appends validated evidence without deleting human history and cannot apply
against a stale queued state version. Repeated same-state actions are no-ops.
[Research](/docs/research/) describes the lifecycle-specific details.

All revision and content APIs retain the deployment-wide owner/service-key gate.
A project’s `public` label is not an anonymous read grant; see [Access](/docs/auth/).
The in-memory domain `ContentList` and these persisted revisions are separate layers.

## Reproducible checks

Run frozen installation, `pnpm test`, `pnpm typecheck`, `pnpm build:app` and
`pnpm site:build`. Newly added tests are coverage, not a product-quality percentage.

For the local synthetic benchmark, run:

```sh
INTEGRITY_BENCH_OUTPUT=/tmp/openworks-integrity \
  pnpm exec vitest run --config scripts/benchmark-integrity.config.mts
```

This writes one JSON file per content kind. It measures the in-memory convex-test
read/modify/write workload with 10 warmups and 100 samples of 1 KiB text, not network,
provider latency, production CPU limits or end-to-end user benefit.
