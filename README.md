<img src="browser/public/icon-192.png" width="76" alt="Openworks" />

# Openworks

**Work in progress, addressable.** A self-hosted workspace where humans and AI agents
work the same material while it is still moving, and every model call goes through an
agent CLI you are already signed in to.

**No API keys. No metered inference. No hosted tier. No subscription to us.**

[![License](https://img.shields.io/badge/license-Apache--2.0-0a0a0a)](LICENSE)
![Self-hosted](https://img.shields.io/badge/self--hosted-by%20design-333333)
![No API keys](https://img.shields.io/badge/provider%20API%20keys-zero-333333)
[![tests](https://github.com/seonglae/openworks/actions/workflows/ci.yml/badge.svg)](https://github.com/seonglae/openworks/actions/workflows/ci.yml)

**Status: pre-release.** It runs, it is what one person uses daily, and the setup
below works. Interfaces will still move.

---

## Why

The unit of public discourse today is the finished artifact: the published paper, the
merged PR, the released product. Review and critique are bolted onto the end of the
pipe, so by the time anyone outside sees the work, the design space has already
collapsed.

Meanwhile AI agents have become collaborators inside the work, but their contributions
stay locked in private sessions. They cannot be cited mid-thought, cannot disagree with
another agent on the record, cannot be argued with by a human peer while it still
matters.

Openworks treats the process itself as the addressable surface. Every entity the work
passes through, a memo, an experiment, a table, a figure, a draft section, a state
transition, is a stable target that can be referenced, commented on, and disagreed with
while it is still moving.

- **Pre-publication, during the procedure.** A half-run ablation and an unresolved
  design memo are valid units to share and take critique on.
- **Humans and agents on equal footing.** A human peer's objection and a reviewer
  agent's objection land in the same thread, separated only by a tag.
- **Cross-entity references are first class.** Memos point at experiments, experiments
  at tables, tables at sections. The graph is the substrate, and comments hang off any
  node in it.
- **Agent-to-agent disagreement stays on the record.**

Research is the first vertical because its artifact taxonomy is well defined. The
substrate underneath is project + entities + references + comments + agents, which
applies wherever a process unfolds over time.

## The same argument, from the other end

Keeping a process open is not a display problem. It only means anything if agents are
actually working the material as it moves: reacting to a state transition, reading an
experiment the moment it is saved, answering a comment without being asked.
Subscriptions here fan out on every one of those events.

Metered inference is the wrong shape for that. When each run bills per token, every
autonomous reaction becomes a purchase, and a product that spends the operator's money
unprompted has to ask first, or batch, or ration. All three close the process back up.

So every model call is dispatched instead to an agent CLI you are already signed in to
(`codex`, `gemini`, `claude`), with a per-task fallback order. Embeddings run locally on
CPU. There is no provider key anywhere in this repo.

That does not make a run free. Subscription plans have rate limits, and the fallback
order exists partly because one provider runs out before the others do. What changes is
the kind of limit: agent work is bounded by quota and wall clock rather than by spend,
so it never has to be justified one invocation at a time.

The consequence is that **Openworks is self-hosted by design**. Your deployment runs
your jobs on your machine under your own logins. There is no hosted tier, because
hosting would mean executing someone else's work on our own keys, which is the metered
product this exists to avoid.

## What it does

| Surface       |                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Research      | projects on a state machine, memos, experiments, tables, figures, sections, tex, venues, cross-references, threaded comments |
| Agents        | subscriptions that fan out on entity events and queue autonomous runs, results posted back as comments                       |
| MCP           | ~50 tools so `codex` / `gemini` / `claude` can read and write the graph directly                                             |
| Intake        | newsletters, arXiv papers, articles and RSS distilled and scored, so the queue is triage rather than reading                 |
| Pull requests | open PRs across your accounts and orgs in one queue                                                                          |
| Digest        | a daily or weekly email of what moved, what was cleared, and what is due                                                     |

### Intake

Newsletters, papers and articles arrive as jobs, get distilled and scored, and leave as
one line each. The queue is triage, not reading.

### The digest

A daily and a weekly mail: what you archived, the papers you scored, the first-author
scores of the voices you follow, where each project sits in the state machine, your open
PRs, and a few words to study. Styled inline rather than through a stylesheet, because
most mail clients drop `<style>` blocks, and trimmed to stay inside Gmail's 102KB
clipping limit.

## Requirements

- Node 22+, pnpm
- A [Convex](https://convex.dev) account (free tier is enough)
- At least one agent CLI signed in: `codex`, `gemini`, or `claude`
- Optional: [Clerk](https://clerk.com) for auth, needed only if you expose the
  deployment beyond localhost

## Setup

```bash
git clone https://github.com/seonglae/openworks.git
cd openworks
pnpm install

cp .env.example .env.local
npx convex dev --once          # creates the deployment, writes CONVEX_DEPLOYMENT
```

The backend refuses every call until it has a service key, so generate one and give it
to both the deployment and your shell:

```bash
KEY=$(openssl rand -hex 32)
npx convex env set OPENWORKS_SERVICE_KEY "$KEY"
echo "OPENWORKS_SERVICE_KEY=$KEY" >> .env.local
```

The browser reads its own env file, and `convex dev` does not write it. Without this the
UI loads to a blank page:

```bash
cp browser/.env.local.example browser/.env.local
# fill in VITE_CONVEX_URL from .env.local, then for local dev only:
echo "VITE_OPENWORKS_SERVICE_KEY=$KEY" >> browser/.env.local
```

That last line is honoured only by a dev build served from localhost; it is stripped
from production bundles at compile time.

```bash
pnpm --filter openworks-browser dev    # UI on http://localhost:6001
```

In a second and third terminal:

```bash
npx tsx scripts/worker.mts             # intake, chat, pr-fix
npx tsx scripts/agent-worker.mts       # agent subscriptions
```

Both workers are long-running, and started this way they stay dead once anything stops
them. For anything but a debugging session, install them as launchd jobs instead:
[`deploy/launchd/README.md`](deploy/launchd/README.md).

### Before exposing it

Set an owner, and the backend starts rejecting every caller who is neither that identity
nor a holder of the service key. Do this before the deployment is reachable from the
internet.

```bash
npx convex env set CLERK_ISSUER_URL https://your-app.clerk.accounts.dev
npx convex env set OPENWORKS_OWNER_USER_ID user_xxx
```

### Agent CLIs

Register the MCP server with whichever CLIs you use, pointing at your checkout:

```bash
node mcp/research-server.mjs      # stdio; register this path in your CLI config
```

The dispatch order per task type lives in `ORDERS` in `scripts/actor.mts`. The default chain is
`gemini -> codex -> claude`; `pr-fix` leads with `codex` because it handles concrete
diffs best.

## Development

```bash
pnpm typecheck     # every workspace, src and test alike
pnpm test          # vitest across packages, convex handlers, browser components
```

## License

Apache-2.0. See [LICENSE](LICENSE).
