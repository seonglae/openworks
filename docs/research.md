# Research use case

Research is one use case of personal content input/output management. This page describes its existing project schema and lifecycle, not a restriction on the kinds of content Openworks can capture and process.

A research project is a slug, a title, a kind, and a position in a state
machine. The research-specific entities on this page hang off that project; the
broader [content loop](/docs/content-management/) also handles standalone material.

## The lifecycle

Projects of kind `own` move through nineteen states:

```
ideation -> literature -> poc -> exp_plan -> design -> setup -> run
  -> analysis -> writing -> pre_submit_check
  -> submit_workshop | submit_main -> reviews -> rebuttal
  -> accepted | rejected -> takeaway -> slide -> poster
```

`pre_submit_check` replaced three separate states that were each a checklist of
the same kind; its sub-items are what used to be those states.

`rejected` is not a dead end and does not fan back only to `writing`. It goes
to whichever of seven earlier states the rejection actually implicates:
`ideation`, `literature`, `exp_plan`, `design`, `analysis`, `writing` or
`takeaway`. A rejection that means "the idea is wrong" and one that means "the
prose is unclear" are not the same rejection.

Projects of kind `review` move through seven:

```
setup -> lit_review -> drafting -> ranking -> submitted -> rebuttal_audit -> final
```

State vocabulary is validated on the server. `advance` also checks adjacency;
`force: true` can bypass adjacency, never the kind’s vocabulary. The UI’s direct
phase selection intentionally accepts any valid state of that kind.

## Entities on a project

Memos, experiments, tables, figures, sections, tex and venues, described in
[Concepts](/docs/concepts/). Memo, section, TeX and experiment writes keep their existing upsert identities,
but versioned rows require the caller’s `expectedRevision` read token. A stale
request fails rather than silently overwriting newer content. See
[Content integrity](/docs/content-integrity/) for the migration and retry contract.

## Venues

A venue is a submission target. Sections and tex can be scoped to one, which is
how the same work carries a four-page workshop version and a nine-page main
version without either being a copy that drifts. `fork_section` and `fork_tex`
make the copy explicit at the moment you decide the two should differ.

## Phase inference

The dropdown, advance, changed upsert/kind registration, legacy migration and
inference share state validation, audit and event handling. A repeated current-state
selection does not append a phantom transition. Existing human history is retained.
Legacy migration respects the project kind (for example, review `submitted` is
still valid and must not be converted to an own-project state).

Inference runs pin project ID, kind, phase and state version when queued. A late
result cannot overwrite a newer human transition, including an away-and-back
change to the same phase. All proposed history entries and timestamps are validated
before any write; malformed entries are rejected atomically. New inference history
is bounded to 256 entries and 128 KiB of serialized history; oversized results fail
without partial application. Completion retains the server-applied history rather
than trusting a replacement transcript supplied by the worker. Valid historical
observations append without rewriting prior records. Rewording a note or omitting
a timestamp on a repeated observation does not manufacture another transition.
Applying the same run again is idempotent. Legacy queued runs without input snapshots
must be requested again. Recovery/reaping of abandoned `researchPhaseRuns` is not
added here; the existing `agentRuns` reaper is unchanged. Local filesystem/git evidence collected by the worker is
labeled as a current observation, not an immutable historical capture.

## Related work

Each project surfaces related jobs and plan items by vector similarity over the
summaries already in your corpus, falling back to a keyword match when nothing
is embedded yet. Intake and the research use case share a deployment so captured
papers, articles and other reading material can inform a project's related work.
