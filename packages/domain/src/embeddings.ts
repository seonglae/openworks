// Which embedding model the app searches with.
//
// The worker loads it to produce vectors and the backend stamps it onto every
// row it stores, so the two have to agree or search silently compares vectors
// from different spaces. That is why the id lives here rather than in either
// of them.

export const EMBED_TARGETS = ["summaries", "researchProjects", "planItems"] as const;
export type EmbedTarget = (typeof EMBED_TARGETS)[number];

// Measured on this corpus by self-retrieval: give each summary its own title as
// a query and see whether it comes back first. Over 20 real Korean summaries,
//
//   all-MiniLM-L6-v2   384-dim    7/20 top-1   MRR 0.463    28ms/doc
//   harrier-oss-270m   640-dim   19/20 top-1   MRR 0.967   177ms/doc
//   embeddinggemma-300m 768-dim  20/20 top-1   MRR 1.000   230ms/doc
//
// all-MiniLM is English-only and could not find thirteen of twenty documents
// from their own headlines, which is not a ranking problem but a reading one.
// EmbeddingGemma scored highest, by one document out of twenty, and is under
// the Gemma terms with a gated repo; harrier is MIT. For a tool other people
// self-host, a licence that travels beats a rounding error in recall.
export const DEFAULT_EMBED_MODEL = "onnx-community/harrier-oss-v1-270m-ONNX";

// Width is a property of the model, not a setting: a vector index fixes its own
// dimensions, so a model of a different width needs its own field and index.
export const EMBED_DIMENSIONS = 640;

export function activeEmbedModel(env: Record<string, string | undefined>): string {
  const m = env.OPENWORKS_EMBED_MODEL;
  return m && m.trim().length > 0 ? m.trim() : DEFAULT_EMBED_MODEL;
}

// A vector search narrows on one filter field: Convex's filter builder offers
// eq and or, and no and. Searching "this model, on this kind of row" is two
// conditions, so they are stored pre-joined and matched as one value.
// "::" cannot occur in a model id, which is a hub path, or in a table name.
export function embedScope(model: string, target: EmbedTarget): string {
  return `${model}::${target}`;
}
