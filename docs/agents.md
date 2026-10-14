# Agents

Agents are the processing layer of personal content input/output management. They react to content changes; research review is one subscription use case.

An agent subscription binds an agent to an event type, so that work happening
in the project provokes a response without anyone asking for one. This is the
part that makes an open process mean something: a state transition nobody
announces is still read, and an experiment is commented on the moment it is
saved.

## Subscriptions

A subscription is a row binding four things:

- an **agent id**, which is just a name you choose: `codex`, `reviewer`,
  whatever the agent calls itself when it posts
- an **event type**: `entity.created`, `entity.updated`, `state.transitioned`
  or `comment.posted`
- an optional **target type**, to narrow to one of the eight entity types
- a **scope**: `global`, `project`, or `workspace`

Subscribe to `state.transitioned` on one project and that agent wakes up
whenever the project moves. Subscribe globally to `entity.created` with target
`experiment` and it reads every matching experiment saved in this owner-gated deployment.
Workspace scope resolves the project’s workspace ID; an existing workspace slug
is accepted as an alias on subscription and list calls.

## What fires an event

Content writes, immutable input snapshots and queued runs commit in one transaction.
A failed write queues no run. The events that fire today:

| Mutation                                                                                                         | Event                                |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `research:advance`                                                                                               | `state.transitioned`                 |
| `research:updatePhase`, changed `research:upsert` / kind registration, valid legacy migration, applied inference | `state.transitioned`                 |
| `comments:post`                                                                                                  | `comment.posted`                     |
| Memo, section, TeX and experiment save/fork                                                                      | `entity.created` or `entity.updated` |

Same-content saves and repeated selections of the current state do not create
revisions or events. Agent-authored comments do not trigger another agent, and
content deletion does not impersonate an update event.

## Runs

A matching subscription queues an `agentRuns` row as `pending`. The agent
worker polls for pending runs every five seconds, claims one, spawns an agent
CLI with the MCP server attached, and writes the result back.

Claiming is atomic. Two workers on the same queue cannot take the same run,
which matters because the usual way to end up with two workers is to start one
by hand next to the supervised one.

The agent is instructed to post a single substantive comment through
`post_comment` with `authorType: "agent"`. One comment, because an agent that
posts five is an agent nobody reads.

## Configuration and exact inputs

`config` is an optional JSON object string, canonicalized at subscription time.
Arbitrary keys are retained within 32 KiB UTF-8, 20 nesting levels and 4,096 values.
Known optional fields are `version: 1`, `instructions` (text), `language` (a nonblank
string up to 80 characters) and `maxCommentChars` (an integer from 1 to 16,000).
The latter is enforced on attributed output comments, counting Unicode code points.
Configuration is prompt data, never executable CLI flags. Invalid old stored configs
use defaults and a content-free diagnostic; they do not break the triggering save.

A run freezes its canonical config, trigger identity and immutable source revision
IDs when queued. Later content or subscription edits do not replace those inputs.
The worker directs the agent to `get_content_revision` for each pinned ID and to
post its output with `runId` and exactly those `sourceRevisionIds`. Author, project,
target and venue must match the running run. One attributed output comment is
immutable and retry-safe; its full snapshot remains available after soft deletion.

Only a claimed, running run can finish. Successful completion requires either a
persisted attributed comment (`commented`) or the exact `NO_ACTION` result with no
comment (`no_action`). Legacy runs without pinned inputs cannot claim an audited
comment; they can report no action or fail and be requested again. Reaped runs
cannot be revived by a late completion. Worker-side completion failures are isolated
so the queue continues. [Content integrity](/docs/content-integrity/) covers storage,
concurrency, migration and limits.

## Cost

A run costs a CLI invocation against a subscription you already pay for, not a
metered API call, and quota and wall clock are what bound it. That is the whole
reason subscriptions can fire without asking you first;
[Agent CLIs](/docs/agent-clis/) has the argument.
