# Research

A research project is a slug, a title, a kind, and a position in a state
machine. Everything else hangs off it.

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

Transitions are validated on the server. `force: true` overrides, for the case
where the work really did skip a step.

## Entities on a project

Memos, experiments, tables, figures, sections, tex and venues, described in
[Concepts](/docs/concepts/). All writes are upserts: saving the same slug twice
updates rather than duplicating, so an agent that retries does not litter.

## Venues

A venue is a submission target. Sections and tex can be scoped to one, which is
how the same work carries a four-page workshop version and a nine-page main
version without either being a copy that drifts. `fork_section` and `fork_tex`
make the copy explicit at the moment you decide the two should differ.

## Phase inference

The phase dropdown on each project row writes through the same validated
transition as `advance` does, so picking a phase by hand fires the same
`state.transitioned` event and the same agent subscriptions. There is no path
that changes a phase without telling the agents.

## Related work

Each project surfaces related jobs and plan items by vector similarity over the
summaries already in your corpus, falling back to a keyword match when nothing
is embedded yet. This is why intake and research are the same deployment: the
papers you read are the corpus the projects search.
