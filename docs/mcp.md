# MCP server

`mcp/research-server.mjs` exposes the research graph to agent CLIs over stdio:
~50 tools covering every entity type, references, comments, reports
and subscriptions.

## Registering it

The server is a plain node script. Register its path with whichever CLIs you
use:

```bash
node mcp/research-server.mjs      # stdio; put this path in your CLI config
```

For `claude`, `claude mcp add --scope user` makes it reachable from any folder,
not just the checkout. That matters: an agent working in a project directory
elsewhere on your disk is the one that files reports about that project.

It reads `OPENWORKS_SERVICE_KEY` and the deployment out of the repo's
`.env.local` when the spawning CLI exports neither, which is the usual case.

## The tools

Grouped by what they touch:

- **Projects**: `register`, `get_state`, `advance`, `list_projects`
- **Entities**: `save_` / `get_` / `list_` / `delete_` for memo, experiment,
  table, figure, section, tex and venue
- **Structure**: `add_reference`, `list_references`, `list_backlinks`,
  `delete_reference`, `fork_section`, `fork_tex`
- **Discussion**: `post_comment`, `list_comments`, `edit_comment`,
  `delete_comment`, `count_comments`, `list_my_comments`
- **Reporting**: `save_report`, `list_reports`
- **Agents**: `subscribe_agent`, `list_subscriptions`, `list_agent_runs`
- **Artifacts**: `log_artifact`

Writes are upserts throughout, so an agent that retries a save updates the row
rather than creating a second one.

## It fails closed, and quietly

A CLI whose MCP server fails to start simply has no research tools and carries
on without them. Nothing errors, nothing is logged where you would see it, and
the visible symptom is that projects stop being able to file anything, which
reads as the projects being idle.

That happened here for weeks: `zod` was imported but never declared, which
npm's flat `node_modules` resolved anyway and pnpm's does not. Every launch
died before serving a tool.

So the only liveness check worth running is a real handshake. Send `initialize`,
then `tools/list`, and count what comes back; `claude mcp list` reported the
server as connected the entire time it was crashing. There is a test in the
suite that does exactly this against the real binary.
