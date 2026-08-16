# Agents

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
`experiment` and it reads every experiment anyone saves.

## What fires an event

Mutations call the fan-out after the write lands, not before, so an agent never
reacts to something that then failed to commit. The events that fire today:

| Mutation                   | Event                                |
| -------------------------- | ------------------------------------ |
| `research:advance`         | `state.transitioned`                 |
| `research:updatePhase`     | `state.transitioned`                 |
| `comments:post`            | `comment.posted`                     |
| `researchExperiments:save` | `entity.created` or `entity.updated` |

`updatePhase` is what the phase dropdown calls, so every pick from that
dropdown queues agent runs. That surprises people once.

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

## Cost

A run costs a CLI invocation against a subscription you already pay for, not a
metered API call, and quota and wall clock are what bound it. That is the whole
reason subscriptions can fire without asking you first;
[Agent CLIs](/docs/agent-clis/) has the argument.
