// Local, on-device sentence embeddings via ONNX runtime in Node. The model is
// fetched from the HuggingFace hub once and then cached on disk; inference runs
// on CPU, with no network after that first fetch and no API key ever.
//
// Uses @huggingface/transformers rather than the older @xenova/transformers.
// That package pins onnxruntime-node 1.14, which rejects any model exported at
// ONNX IR version 10 ("max supported IR version: 8") and does not know the
// architectures shipped since. Every current embedding model fails to load on
// it, so the choice of model was really a choice of library.
//
// Whichever model is configured, its width has to match a vector index in
// convex/schema.ts. Width is a property of the model, not a setting.

import { AutoModel, AutoTokenizer, env } from "@huggingface/transformers";
import { activeEmbedModel } from "@openworks/domain";

// Fetch from the hub on first use, cache to disk, reuse thereafter.
env.allowLocalModels = false;

// Exported because the id is stored alongside every vector this produces.
// Search has to know which space a vector came from, and this is the only place
// that knows which model actually ran.
export const EMBED_MODEL = activeEmbedModel(process.env);

type Loaded = { model: any; tok: any };
let loading: Promise<Loaded> | null = null;
function load(): Promise<Loaded> {
  if (!loading) {
    loading = (async () => ({
      tok: await AutoTokenizer.from_pretrained(EMBED_MODEL),
      // Quantized weights: this runs beside the worker on a laptop CPU, and the
      // retrieval difference against float was not measurable on this corpus.
      model: await AutoModel.from_pretrained(EMBED_MODEL, { dtype: "q8" }),
    }))();
  }
  return loading;
}

const l2 = (v: number[]): number[] => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};

// Two export shapes exist and both are common. Sentence-transformer exports
// pool inside the graph and hand back `sentence_embedding`; plain encoder
// exports hand back `last_hidden_state` and expect the caller to pool, counting
// only real tokens or the padding drags every vector toward the same point.
function toVectors(out: any, attentionMask: number[]): number[][] {
  if (out.sentence_embedding) {
    const t = out.sentence_embedding;
    const [n, d] = t.dims;
    const flat = Array.from(t.data as Float32Array);
    return Array.from({ length: n }, (_, i) => l2(flat.slice(i * d, (i + 1) * d)));
  }
  const t = out.last_hidden_state;
  const [n, seq, d] = t.dims;
  const flat = Array.from(t.data as Float32Array);
  return Array.from({ length: n }, (_, i) => {
    const acc = new Array(d).fill(0);
    let count = 0;
    for (let s = 0; s < seq; s++) {
      if (!attentionMask[i * seq + s]) continue;
      count++;
      for (let k = 0; k < d; k++) acc[k] += flat[(i * seq + s) * d + k];
    }
    return l2(acc.map((x) => x / (count || 1)));
  });
}

// Batched so a large backfill does not build one enormous padded tensor: the
// batch pads to its own longest member, and mixing a 20-character title with a
// 1200-character summary in one tensor wastes most of the compute on padding.
const BATCH = 8;

// L2-normalized, so a plain dot product equals cosine similarity, which is what
// Convex vector search computes.
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { model, tok } = await load();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const inputs = await tok(texts.slice(i, i + BATCH), { padding: true, truncation: true });
    const result = await model(inputs);
    const mask = Array.from(inputs.attention_mask.data as BigInt64Array).map(Number);
    out.push(...toVectors(result, mask));
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embed([text]);
  return vec;
}
