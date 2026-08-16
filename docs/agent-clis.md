# Agent CLIs

Every model call in Openworks is dispatched to a command-line agent you are
already signed in to. There is no provider API key anywhere in this repository,
and adding one would defeat the design.

## Why not an API

Metered inference is the wrong shape for a product that acts on its own. When
each run bills per token, every autonomous reaction becomes a purchase, and
software that spends the operator's money unprompted has to ask first, or
batch, or ration. All three close the process back up, which is the thing this
is trying to keep open.

Dispatching to a CLI moves the cost onto a subscription that is already paid
for. What remains is a rate limit and a wall clock, which bound a run without
requiring it to be justified one invocation at a time.

It also means the deployment cannot be hosted for you. Hosting would mean
running your work on our logins, which is exactly the metered product this
exists to avoid.

## The dispatch layer

`scripts/actor.mts` is the only place a provider is spawned. It builds the argv
for each CLI, runs it, and falls through to the next one on failure.

The default order is `codex`, then `antigravity`, then `claude`. Per task type:

| Task                                                            | Order                      |
| --------------------------------------------------------------- | -------------------------- |
| `newsletter`, `paper`, `article`, `insight`, `chat`, `agentRun` | codex, antigravity, claude |
| `pr-fix`                                                        | codex, claude, antigravity |
| anything else                                                   | the default                |

`pr-fix` differs because it is the one task that is a concrete diff against a
real checkout.

Override the first provider with `AI_PROVIDER`. The fallback chain after it is
unchanged.

## Invocation flags

The argv is pinned by tests, because a wrong flag does not crash. The CLI exits
zero having achieved nothing, the job never leaves `summarizing`, and the
failure reads as the model being bad rather than the invocation being wrong.

The one worth knowing: `codex exec` sandboxes to workspace-write, which denies
network. Every prompt the worker builds writes its result back over the
network, so network access is enabled explicitly. Without it codex cannot
finish a single job.

## Embeddings

Embeddings are not dispatched. They run locally on CPU through ONNX, in the
worker process. This is why there is no embedding key either.
