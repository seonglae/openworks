# Deploying

There is no hosted Openworks to sign up for, and there never will be. That is a
statement about whose keys run your work, not about how hard this is to stand
up: one click puts the backend and the UI into your own Vercel and Convex
accounts, provisioned as you go.

The two workers stay on your machine. That half is not missing, it is the
point, and the last section says why.

## One click

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fseonglae%2Fopenworks&project-name=openworks&repository-name=openworks&demo-title=Openworks&demo-description=A%20self-hosted%20workspace%20where%20humans%20and%20AI%20agents%20work%20the%20same%20material%20while%20it%20is%20still%20moving.&demo-url=https%3A%2F%2Fopenworksai.app&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22convex%22%2C%22productSlug%22%3A%22convex%22%2C%22protocol%22%3A%22storage%22%7D%5D&env=VITE_CLERK_PUBLISHABLE_KEY&envDescription=Clerk%20publishable%20key.%20The%20deployment%20is%20owner-only%2C%20so%20it%20needs%20an%20identity%20provider%20to%20know%20who%20you%20are.&envLink=https%3A%2F%2Fopenworksai.app%2Fdocs%2Fdeploy%2F)

In order, that flow:

1. clones this repository into your own GitHub, GitLab or Bitbucket account
2. installs the Convex integration from the Vercel Marketplace and provisions a
   Convex project under your own Convex team, handing the build a deploy key
3. asks you for one value, `VITE_CLERK_PUBLISHABLE_KEY`
4. builds both halves in a single command

Step 2 is the only reason this is one click rather than two. Convex is a
Marketplace integration, so Vercel can create the backend during the import
instead of asking you to go and make one first.

### What the build actually runs

```bash
npx convex deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd 'pnpm build:app'
```

`convex deploy` pushes the schema and the functions to the project the
integration just created, then runs the frontend build with that deployment's
URL in `VITE_CONVEX_URL`, which Vite compiles into the bundle.

`vercel.json` guards that on `CONVEX_DEPLOY_KEY` and falls back to a plain
`pnpm build:app`. Without the guard the file would only serve the button: a
deployment you provisioned yourself and now want a hosted page for has no
deploy key, and an unconditional `convex deploy` would fail its build. With it,
one file covers both, and the fallback build uses whatever `VITE_CONVEX_URL`
you set on the project.

### Clerk

Openworks is single-owner. There is no anonymous mode to fall back to once the
page is on the public internet, so the deploy asks for a Clerk publishable key
rather than letting you find out later. A free Clerk application takes about a
minute: create it, then copy the key from **API keys**.

## Then three values on Convex

What comes out of the build is a **closed** backend. `requireOwner` answers
`unconfigured` to every caller until it knows who the owner is, and that is
deliberate: the deployment URL ships inside the browser bundle, so the moment
the page is reachable the backend is reachable too. Failing closed is the only
safe default for a deployment whose first state is public.

Open the Convex dashboard for the project the integration created. The Vercel
project lists the Convex resource alongside its other integrations and links
straight into it. Set these three on the deployment:

| variable                | value                                                             |
| ----------------------- | ----------------------------------------------------------------- |
| `CLERK_ISSUER_URL`      | Clerk dashboard, **JWT Templates**, the `convex` template, Issuer |
| `OPENWORKS_OWNER_EMAIL` | the address on your Clerk account                                 |
| `OPENWORKS_SERVICE_KEY` | `openssl rand -hex 32`, and keep it, the workers present this     |

Reload the page and sign in. If it loads to "signed in, but this account does
not have access", the screen prints the email and subject your token actually
carries: matching by email needs the Clerk JWT template to include an `email`
claim, and matching by `OPENWORKS_OWNER_USER_ID` is the fallback when it does
not. [Auth and sharing](/docs/auth/) covers the gate in full.

## The half that stays on your machine

The workers are not deployable, and that is the design rather than a gap.
Every model call is dispatched to an agent CLI that is already signed in as
you. A container in someone else's region has none of those logins, and giving
it one would mean handing over the credential, which is the metered arrangement
this exists to avoid. The MCP server is local for the same reason: it speaks
stdio to a CLI running next to it.

So the hosted half is the surface, and the local half is what moves. Point the
workers at the deployment you just made by giving `.env.local` its URL and the
service key you set above:

```bash
CONVEX_URL=https://your-deployment.convex.cloud
OPENWORKS_SERVICE_KEY=the-same-value-you-set-on-convex
```

```bash
npx tsx scripts/worker.mts             # intake, chat, PR fixes
npx tsx scripts/agent-worker.mts       # agent subscriptions
```

A mismatched key is the common failure, and it reads as `auth required` on
every call rather than as an authentication error, because to the backend a
wrong key and no key are the same thing. [Workers](/docs/workers/) covers
keeping both processes alive.

## Anywhere else

**There is no "deploy to Convex" button.** Convex hosts the backend, not the
page, and its own docs point at Vercel or Netlify for the frontend. Nothing is
missing here: the Vercel button already provisions a Convex project, which is
as close to one as the shape of the two products allows.

Every other host can serve the UI, but none of them can create the backend, so
provision that yourself first, from a checkout:

```bash
npx convex deploy
```

Then build the page anywhere that runs Node:

| setting        | value                                           |
| -------------- | ----------------------------------------------- |
| install        | `pnpm install --frozen-lockfile`                |
| build          | `pnpm build:app`                                |
| output         | `browser/dist`                                  |
| build-time env | `VITE_CONVEX_URL`, `VITE_CLERK_PUBLISHABLE_KEY` |

Both `VITE_` values are read at build time and compiled into the bundle, so
changing either one means rebuilding, not restarting. No SPA rewrite rule is
needed: every route in the app is a query string on `/`, never a path segment.

For Cloudflare Pages that is:

```bash
pnpm build:app
npx wrangler pages deploy browser/dist --project-name=openworks-app
```

A "Deploy to Cloudflare" button is possible in the same shape, and deliberately
not offered: it provisions Cloudflare resources, and Convex is not one of them,
so the click would end at a page wired to a backend that does not exist yet.
One button that finishes is worth more than two that need the same manual step
afterwards.

## Next

- [Auth and sharing](/docs/auth/), for the owner gate and what changes when a
  project is made public
- [Configuration](/docs/configuration/), for every variable and what happens
  when it is unset
- [Workers](/docs/workers/), for supervising the local half
