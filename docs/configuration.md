# Configuration

Two files and a deployment. `.env.local` is read by the workers and the MCP
server; `browser/.env.local` is read by the browser build; and anything marked
"deployment" also has to be set on Convex itself, which does not read either
file:

```bash
npx convex env set <KEY> <VALUE>
```

`.env.example` is the tracked template and lists everything below.

## Required

| Variable                | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `CONVEX_DEPLOYMENT`     | your deployment, written by `npx convex dev` on first run      |
| `OPENWORKS_SERVICE_KEY` | the shared secret the workers and MCP present. Deployment too. |

## Locking it down

| Variable                  | What it does                                                   |
| ------------------------- | -------------------------------------------------------------- |
| `CLERK_ISSUER_URL`        | Clerk JWT issuer. Deployment.                                  |
| `OPENWORKS_OWNER_EMAIL`   | the owner, matched against the JWT's email claim. Preferred.   |
| `OPENWORKS_OWNER_USER_ID` | the owner as a Clerk subject, if the template carries no email |

See [Auth and sharing](/docs/auth).

## Optional

| Variable                                                            | Unset means                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `OPENWORKS_DIGEST_TO`, `OPENWORKS_DIGEST_HOUR`, `OPENWORKS_APP_URL` | no digest is ever sent                                                          |
| `GITHUB_TOKEN`                                                      | PR calls are anonymous: no private repos, and the rate limit runs out           |
| `NOTION_TOKEN`                                                      | insights and newsletters still enrich and score, they just cannot write back    |
| `NOTION_INSIGHTS_ROOT`                                              | the agent searches the whole workspace, and picks a worse page the bigger it is |
| `SCREENSHOT_INGEST_SECRET`                                          | the mobile ingest endpoint answers 503, so no open ingest exists by accident    |
| `OPENALEX_MAILTO`                                                   | author lookups use the common pool instead of the polite one                    |
| `AI_PROVIDER`                                                       | the default provider order applies                                              |
| `OUTLOOK_CALENDAR_ID`, `OUTLOOK_EXTRA_CALENDAR_IDS`                 | the sync reads the account's default calendar                                   |
| `OPENWORKS_USAGE_RETENTION_DAYS`                                    | usage rows are kept 180 days                                                    |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`            | no web push. All three are required for any. Deployment.                        |

## Machine-local

Every one has a working default, and
`node scripts/configure-machine.mjs` writes the same answers to
`~/.config/openworks/config.json`, which wins over the environment.

| Variable                  | Default                 |
| ------------------------- | ----------------------- |
| `OPENWORKS_MACHINE_ID`    | the hostname            |
| `OPENWORKS_PROJECTS_ROOT` | the parent of this repo |
| `OPENWORKS_PR_ROOT`       | `../PR`                 |

Project directories are discovered rather than listed: any git checkout sitting
under the projects root, slugged from its directory name. A written-in list is
only ever right on the machine it was written on.

## The browser

`browser/.env.local`, from `browser/.env.local.example`:

| Variable                     | What it does                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `VITE_CONVEX_URL`            | the deployment the UI talks to                                                             |
| `VITE_CLERK_PUBLISHABLE_KEY` | enables sign-in; without it the UI falls back to an unauthenticated provider               |
| `VITE_OPENWORKS_SERVICE_KEY` | local dev only, honoured on localhost and stripped from production bundles at compile time |
