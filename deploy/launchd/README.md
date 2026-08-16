# Keeping the workers alive (macOS)

`nohup ... & disown` starts a worker but nothing restarts one. A worker that
takes a `SIGTERM` stays down, silently, until somebody notices the queue is not
moving. One of them was dead for 52 minutes before anyone looked.

These templates hand that job to launchd, which restarts the process and brings
it back after a reboot.

## Install

From the repo root:

```bash
ROOT=$(pwd)
for job in worker agent-worker; do
  sed -e "s|__ROOT__|$ROOT|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__PATH__|$PATH|g" \
      "deploy/launchd/com.openworks.$job.plist.template" \
      > "$HOME/Library/LaunchAgents/com.openworks.$job.plist"
  launchctl unload "$HOME/Library/LaunchAgents/com.openworks.$job.plist" 2>/dev/null
  launchctl load  "$HOME/Library/LaunchAgents/com.openworks.$job.plist"
done
```

Passing your live `$PATH` through is deliberate. launchd gives a job a
near-empty PATH, and both workers spawn `codex` / `gemini` / `claude` by name,
so a short PATH fails every job at the provider lookup while the worker process
itself looks perfectly healthy. Run the install from an interactive shell, not
from a script with a stripped environment.

Stop the manually launched copies first, or you will have two workers racing for
the same queue:

```bash
pkill -f "tsx scripts/worker.mts"
pkill -f "tsx scripts/agent-worker.mts"
```

## Check

```bash
launchctl list | grep openworks     # pid and last exit code
tail -f /tmp/openworks-worker.log
```

## Stop

`launchctl stop` is not enough, since `KeepAlive` starts it straight back up:

```bash
launchctl unload ~/Library/LaunchAgents/com.openworks.worker.plist
```

## Caveats

- Logs go to `/tmp`, which macOS clears on reboot. Point `StandardOutPath`
  somewhere durable if you want history across restarts.
- `KeepAlive` is unconditional, so an intentional stop needs `unload`. The
  30 second `ThrottleInterval` keeps a crash-on-startup to a slow drip rather
  than a fork loop.
- The workers read `.env.local` from `WorkingDirectory`, so the repo has to be
  readable by the logged-in user launchd runs as.
