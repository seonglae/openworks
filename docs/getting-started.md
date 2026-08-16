# Getting started

Openworks is one Convex deployment, one browser UI and two worker processes,
all of them yours. Nothing here calls a service we run, because there isn't
one.

## What you need

- Node 22 or newer, and pnpm
- A [Convex](https://convex.dev) account. The free tier is enough for one
  operator.
- At least one agent CLI already signed in: `codex`, `gemini` or `claude`.
  This is where every model call goes, so with none of them installed the
  intake queue fills up and nothing leaves it.
- Optional: a [Clerk](https://clerk.com) application, needed only when the
  deployment becomes reachable from somewhere other than your own machine.

## Provision the backend

```bash
git clone https://github.com/seonglae/openworks.git
cd openworks
pnpm install

cp .env.example .env.local
npx convex dev --once          # creates the deployment, writes CONVEX_DEPLOYMENT
```

The backend refuses every call until it has a service key. This is deliberate:
the deployment URL ships inside the browser bundle, so the moment the UI is
reachable the backend is too, by anyone who loads the page. Generate a key and
give it to both the deployment and your shell.

```bash
KEY=$(openssl rand -hex 32)
npx convex env set OPENWORKS_SERVICE_KEY "$KEY"
echo "OPENWORKS_SERVICE_KEY=$KEY" >> .env.local
```

## Start the UI

The browser reads its own environment file and `convex dev` does not write it.
Skip this and the UI loads to a blank page.

```bash
cp browser/.env.local.example browser/.env.local
# fill in VITE_CONVEX_URL from .env.local, then, for local dev only:
echo "VITE_OPENWORKS_SERVICE_KEY=$KEY" >> browser/.env.local

pnpm --filter openworks-browser dev    # http://localhost:6001
```

That last line is honoured only by a dev build served from localhost. It is
stripped from production bundles at compile time, so it cannot leak into a
deployed page.

## Start the workers

In a second and third terminal, from the repo root:

```bash
npx tsx scripts/worker.mts             # intake, chat, PR fixes
npx tsx scripts/agent-worker.mts       # agent subscriptions
```

Both are long-running, and started this way they stay dead once anything stops
them. For anything but a debugging session install them as supervised jobs
instead; see [Workers](/docs/workers/).

## Check it works

Paste an arXiv link into the Paper tab. A job appears as `pending`, a worker
claims it, an agent CLI reads the paper and writes back a summary and a score,
and the row settles. If it sits at `pending` forever the worker is not running;
if it fails at `summarizing` no agent CLI was reachable on the worker's PATH.

## Next

- [Concepts](/docs/concepts/), for what the entities are and how they refer to
  each other
- [Agent CLIs](/docs/agent-clis/), for how a model call is dispatched
- [Auth and sharing](/docs/auth/), before you expose the deployment
