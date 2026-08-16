# Workers

Two long-running node processes. Both resolve `.env.local` and every relative
path from the repository root, so both must be started from there.

## worker.mts

Polls the job queues: intake, chat replies, PR fixes, feeds, insights, the
digest, and the stuck-job sweep. Claims a row, marks it with this machine's id,
dispatches to an agent CLI, writes the result back.

```bash
npx tsx scripts/worker.mts
```

It watches its own sources and exits when they change, so that a supervisor
restarts it. An edit reaches the next run with nothing to do by hand. The
corollary: **moving a worker file means updating its supervisor definition in
the same breath**, or the restart lands on a path that no longer exists.

## agent-worker.mts

Polls `agentRuns` for pending rows every five seconds, claims one, spawns a CLI
with the MCP server attached, and completes the run. See [Agents](/docs/agents/).

```bash
npx tsx scripts/agent-worker.mts
```

## Keeping them up

Started by hand they stay dead once anything stops them, and a worker that has
been dead for three days looks exactly like a quiet week. On macOS,
`deploy/launchd/` has templates that install both as user agents with
`KeepAlive`, which restart them on crash and on login.

Two things about running them supervised:

- **Only one worker per queue.** Starting one by hand next to the supervised
  one puts two on the same queue. Claiming is atomic so nothing is processed
  twice, but the second worker is invisible and confusing.
- **Read the log the supervisor actually writes.** An old log file from a
  manual run sits in `/tmp` looking like a worker that died days ago, and the
  supervisor's own file is somewhere else. Take the path from the job
  definition rather than guessing.

## Machine identity

A worker names itself with `OPENWORKS_MACHINE_ID`, defaulting to the hostname.
This is what a claimed row is stamped with, so it only matters if two of your
machines share a hostname.
