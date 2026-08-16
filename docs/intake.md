# Intake

Newsletters, papers, articles and feeds arrive as jobs, get distilled and
scored, and leave as one line each. The queue is triage, not reading.

## The pipeline

A job is created by pasting a URL or text into a tab, by the RSS poller, or by
a mobile client posting to the ingest endpoint. From there:

1. The row lands as `pending`.
2. A worker claims it, marking it with its machine id so two workers on the
   same queue cannot both take it.
3. The worker builds a prompt and dispatches it to an agent CLI. For a paper it
   fetches the PDF and converts it to text first, because a summary written
   from the abstract is a summary of the abstract.
4. The agent writes back a summary, a category, keywords, and for papers and
   articles a set of scores.
5. The row settles.

Everything the pipeline writes while a job is in flight goes under `tmp/`, and
nothing is kept after it settles.

## Types

| Type         | Source                                                  | What comes back                           |
| ------------ | ------------------------------------------------------- | ----------------------------------------- |
| `newsletter` | pasted content, or an unread mail                       | per-link distillation, one line each      |
| `paper`      | arXiv, OpenReview, DOI, a pasted title, or a screenshot | summary, scores, keywords, related papers |
| `article`    | a URL or pasted text                                    | summary, category, score                  |
| `pr-fix`     | the PR queue                                            | a diff, dispatched to `codex` first       |

## Scoring

Papers and articles get an overall score out of ten. The bands that matter are
7 and above (worth keeping), 5 to 7 (marginal), and below 5 (noise). The score
distribution on the tab is drawn from the whole corpus, so a score means
something relative to what you have already read rather than in the abstract.

Scores are the agent's judgement, not a metric. They are useful for ordering a
backlog and misleading if read as a measurement.

## Embeddings

Summaries are embedded locally, on CPU, through ONNX. This is what powers
related-paper lookup and the vector search behind a project's related jobs.
There is no embedding API and no key: the model runs in the worker process.

## Feeds

RSS and arXiv listing feeds are polled on a schedule and enqueued as jobs with
an origin label. The label is what lets the digest say which source a week's
reading came from.
