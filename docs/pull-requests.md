# Pull requests

The PR queue is a software-work use case within personal content input/output management. It keeps external work items beside reading and writing material.

Open pull requests across every account and org you have, in one queue, with a
fix dispatchable to an agent CLI.

## The queue

The PR tab reads GitHub with the token in `GITHUB_TOKEN`. Without a token the
calls are anonymous: no private repository is visible and the rate limit runs
out quickly. A classic token with `repo` scope is enough.

PRs are grouped by repository. Within a repository, human-authored PRs sort
above bot ones, because a queue where thirty-one of thirty-four rows are
dependency bumps buries the three that need you.

Bot PRs are listed rather than collapsed into a count. Collapsing them hid the
occasional bump that broke something.

## Fixes

Dispatching a fix creates a `pr-fix` job. That job type has its own provider
order, leading with `codex`, because it handles a concrete diff against a real
checkout better than the alternatives. See [Agent CLIs](/docs/agent-clis/).

The worker runs the fix in a checkout under the PR root, which defaults to
`../PR` and is configurable with `OPENWORKS_PR_ROOT`.

## In the digest

Open PRs are a section of the emailed digest, linking back into the app rather
than out to GitHub when an app URL is configured, so that a link from the mail
lands somewhere the fix can be dispatched from.

## Content-integrity change checklist

The adapter recovery and the persistence follow-on are separate review checkpoints.
Match each lesson to [Product comparison](/docs/product-comparison/) and keep local
coverage distinct from measured behavior. This follow-on records:

- [x] **Notion:** persisted snapshots and stale-write checks for four existing content types; output preparation stays separate from publication.
- [x] **Readwise:** immutable queued source IDs, config snapshots and validated run/output attribution; no passage-verification claim.
- [x] **Capacities:** existing screenshot identity/OCR separation remains covered; no OCR execution added.
- [x] **Obsidian:** provider-neutral content contracts remain portable; backend binary history is a separate storage concern.
- [x] **NotebookLM / Gemini Notebook:** reference-only evidence remains explicit; new run records pin exact available revisions, without video-quality claims.
- [x] **Descript:** preserved editable content history and concurrency checks are foundations for revision-aware work, without scene/media editing.
- [x] **MoneyPrinterTurbo:** renderer integration remains an isolated future adapter, with no live renderer or license-parity claim.
- [x] **Texonom:** source identity is preserved without claiming taxonomy mapping or importing private project material.
- [x] Record the newly defined eight-case failing-before/passing-after fixture against exact PR #5, full repository checks and same-workload latency/storage cost.
- [x] Document deliberate client migration: versioned writes require the original read token; whole-project deletion is a separate destructive lifecycle boundary.
- [ ] Restore UI, full source-byte/image capture, OCR and verified claim spans.
- [ ] Anonymous public access, direct Notion publication and hosted standards-compliant feeds.
- [ ] Video script/storyboard model, rendering, cost/cancellation controls and provider/video evaluations.

[Content integrity](/docs/content-integrity/) explains the implemented boundary.
Historical PR evidence must stay tied to its original head; a newer test count or
local benchmark does not retroactively change an earlier claim.
