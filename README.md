<img src="browser/public/icon-192.png" width="76" alt="Openworks" />

# Openworks

**Personal content input/output management.** Capture links, screenshots, papers and
notes; process them into reusable content; prepare useful outputs with the agent CLIs
you already use. Research is one workflow in this broader personal content loop.

[Content architecture and adapter boundaries](docs/content-management.md) ·
[Product comparison and roadmap](docs/product-comparison.md).

**No API keys. No metered inference. No hosted tier. No subscription to us.**

[![License](https://img.shields.io/badge/license-Apache--2.0-0a0a0a)](LICENSE)
![Self-hosted](https://img.shields.io/badge/self--hosted-by%20design-333333)
![No API keys](https://img.shields.io/badge/provider%20API%20keys-zero-333333)
[![tests](https://github.com/seonglae/openworks/actions/workflows/ci.yml/badge.svg)](https://github.com/seonglae/openworks/actions/workflows/ci.yml)

**Status: pre-release.** It runs, I use it daily, and the setup below works.
Interfaces will still move.

**Docs: [openworksai.app/docs](https://openworksai.app/docs)**, one page per
surface, written from `docs/` in this repo.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fseonglae%2Fopenworks&project-name=openworks&repository-name=openworks&demo-title=Openworks&demo-description=Self-hosted%20personal%20content%20input%2Foutput%20management.&demo-url=https%3A%2F%2Fopenworksai.app&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22convex%22%2C%22productSlug%22%3A%22convex%22%2C%22protocol%22%3A%22storage%22%7D%5D&env=VITE_CLERK_PUBLISHABLE_KEY&envDescription=Clerk%20publishable%20key.%20The%20deployment%20is%20owner-only%2C%20so%20it%20needs%20an%20identity%20provider%20to%20know%20who%20you%20are.&envLink=https%3A%2F%2Fopenworksai.app%2Fdocs%2Fdeploy%2F)

Clones this repo into your account, provisions a Convex project through the
Vercel Marketplace, and builds the backend and the UI in one command. Three
variables on the Convex deployment and it is yours:
[deploying](https://openworksai.app/docs/deploy/). The workers stay on your
machine either way, because every model call goes to an agent CLI signed in as
you.

---

## Why

Personal material arrives in different forms and leaves through different tools. A
screenshot, an article, a paper and a note should not require four disconnected
workflows just to become a useful summary, draft or reading feed.

Openworks separates **Input → Processing → Output** around canonical content lists.
Input adapters preserve source references. Processing transforms working text while
retaining evidence. Output adapters prepare destination-specific data. The existing
intake queue, project graph, agents and digest are useful surfaces over that loop.

- **Capture:** URLs, pasted text and screenshots enter the existing intake jobs.
- **Process:** agent CLIs distill and score material; reusable content keeps its source.
- **Prepare outputs:** Notion export plans and portable feed records have independent,
  side-effect-free adapters. Existing digest and project workflows remain available.
- **Research is one use case:** papers, experiments, figures and sections use the
  existing research schema. Its API names remain compatible, without defining the
  whole product as a research workspace.

The new adapters are a typed foundation, not a claim that every existing worker has
been migrated. Notion publishing, a hosted feed endpoint and video rendering are not
implemented by these adapters. See the [capability matrix](docs/content-management.md).

## The same argument, from the other end

The content loop needs processing as well as storage. Existing workers distill intake
jobs, and agent subscriptions can react when a project artifact changes, its state
advances, or a comment arrives. A saved experiment is one such artifact; the same
personal workspace also holds reading material, notes and drafts.

Metered inference is the wrong shape for that. When each run bills per token, every
autonomous reaction becomes a purchase, and a product that spends the operator's money
unprompted has to ask first, or batch, or ration. All three close the process back up.

So every model call is dispatched instead to an agent CLI you are already signed in to
(`codex`, `antigravity`, `claude`), with a per-task fallback order. Embeddings run locally on
CPU. There is no provider key anywhere in this repo.

That does not make a run free. Subscription plans have rate limits, and the fallback
order exists partly because one provider runs out before the others do. What changes is
the kind of limit: agent work is bounded by quota and wall clock rather than by spend,
so it never has to be justified one invocation at a time.

The consequence is that **Openworks is self-hosted by design**. Your deployment runs
your jobs on your machine under your own logins. There is no hosted tier, because
hosting would mean executing someone else's work on our own keys, which is the metered
product this exists to avoid.

That is a claim about whose keys run the work, not about how much setup you deserve.
The deploy button above provisions into accounts that are yours, and the split it
leaves behind is the honest one: the page and the database can sit anywhere, while the
processes that spend your agent quota stay where your logins already are.

## What it does

| Surface             |                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content contracts   | separate Input, Processing and Output adapters sharing ordered content lists; Notion and feed export preparation, without publication                                                       |
| Research use case   | projects on a state machine, memos, experiments, tables, figures, sections, tex, venues, cross-references, threaded comments                                                                |
| Persisted integrity | immutable memo/section/TeX/experiment revisions, required read tokens on versioned writes, pinned agent inputs and audited state changes; [migration and limits](docs/content-integrity.md) |
| Agents              | subscriptions that fan out on entity events and queue autonomous runs, results posted back as comments                                                                                      |
| MCP                 | ~50 tools so `codex` / `antigravity` / `claude` can read and write the graph directly                                                                                                       |
| Intake              | newsletters, arXiv papers, articles and RSS distilled and scored, so the queue is triage rather than reading                                                                                |
| Pull requests       | open PRs across your accounts and orgs in one queue                                                                                                                                         |
| Digest              | a daily or weekly email of what moved, what was cleared, and what is due                                                                                                                    |

### Intake

Newsletters, papers and articles arrive as jobs, get distilled and scored, and leave as
one line each. The queue is triage, not reading.

### The digest

A daily and a weekly mail: what you archived, the papers you scored, what to read next
out of the backlog, where each project sits in the state machine, your open PRs, and a
few words to study. Styled inline rather than through a stylesheet, because most mail
clients drop `<style>` blocks, and trimmed to a 72KB body, which is what fits under
Gmail's 102KB clipping threshold once both MIME parts are base64.

## Requirements

- Node 22+, pnpm
- A [Convex](https://convex.dev) account (free tier is enough)
- At least one agent CLI signed in: `codex`, `antigravity`, or `claude`
- Optional: [Clerk](https://clerk.com) for auth, needed only if you expose the
  deployment beyond localhost

## Setup

Everything below is the local path, which is also what you run alongside a hosted
deployment. For the hosted half, see [deploying](https://openworksai.app/docs/deploy/).

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
`codex -> antigravity -> claude`; `pr-fix` swaps the last two because it handles a
concrete diff better than either alternative.

## Development

```bash
pnpm typecheck     # every workspace, src and test alike
pnpm test          # vitest across packages, convex handlers, browser components
pnpm site:build    # the homepage and docs, into site/dist
```

The docs on the site are the markdown in [`docs/`](docs), rendered. Change a
feature and its page is in the same repository as the change.

The phone client is a native SwiftUI app in [`ios/`](ios/Openworks), talking to
the same Convex backend over the owner service key. It is not a wrapper around
the web app: the desktop keeps the surfaces that need a keyboard and a canvas,
and the phone gets reading, the plan, and project timelines for the research use case.

## License

Apache-2.0. See [LICENSE](LICENSE).
