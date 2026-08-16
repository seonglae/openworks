# Auth and sharing

Openworks is a single-operator deployment. The backend is closed by default and
opens along exactly two paths: an owner identity, or a service key.

## Closed by default

With neither `OPENWORKS_OWNER_EMAIL` nor `OPENWORKS_OWNER_USER_ID` set, every
public function rejects any caller that does not present the service key. It
used to let everyone through on the theory that a fresh checkout is a local
one, which is not true: the deployment URL ships inside the browser bundle, so
the first time the UI is reachable the backend is too, by anyone who loads the
page.

With no service key either, every call fails as `unconfigured`. That is the one
state a deployment should never be silently usable in.

## The service key

A shared secret the workers and the MCP server present instead of a session.
Generate it with `openssl rand -hex 32`, and give the same value to the
deployment and to the worker environment.

It is a bearer credential with full access. Never commit it, and rotate it if
it leaks.

## The owner

Set an owner before the deployment is reachable from the internet:

```bash
npx convex env set CLERK_ISSUER_URL https://your-app.clerk.accounts.dev
npx convex env set OPENWORKS_OWNER_EMAIL you@example.com
```

Prefer the email over the Clerk user id. It survives a Clerk instance change or
a user-id change, and it is the one of the two you already know. It requires
the JWT template to carry an `email` claim; `settings:whoami` prints what the
signed-in identity actually carries.

Flip this on only after every worker and MCP call site passes the service key,
or the automation loses backend access at the same moment you gain the lock.

## Sharing a project

Each project has a visibility: `private`, `workspace`, `unlisted` or `public`.
Set it to unlisted or public and the row shows a share URL of the form
`<origin>/?research=<slug>`.

Unlisted means anyone with the link; public means anyone at all. Neither
exposes the intake queue, the digest, or any other project.

Projects created before multi-tenancy existed have no owner recorded and are
treated as open until backfilled.
