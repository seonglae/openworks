# Pull requests

Open pull requests across every account and org you have, in one queue, with a
fix dispatchable to an agent CLI.

## The queue

The PR tab reads GitHub with the token in `GITHUB_TOKEN`. Without a token the
calls are anonymous: no private repository is visible and the rate limit runs
out quickly. A classic token with `repo` scope is enough.

PRs are grouped by repository. Within a repository, human-authored PRs sort
above bot ones, because a queue where thirty-one of thirty-four rows are
dependency bumps buries the three that need you.

Bot PRs are listed rather than collapsed into a count. Collapsing them hid the
occasional bump that broke something.

## Fixes

Dispatching a fix creates a `pr-fix` job. That job type has its own provider
order, leading with `codex`, because it handles a concrete diff against a real
checkout better than the alternatives. See [Agent CLIs](/docs/agent-clis).

The worker runs the fix in a checkout under the PR root, which defaults to
`../PR` and is configurable with `OPENWORKS_PR_ROOT`.

## In the digest

Open PRs are a section of the emailed digest, linking back into the app rather
than out to GitHub when an app URL is configured, so that a link from the mail
lands somewhere the fix can be dispatched from.
