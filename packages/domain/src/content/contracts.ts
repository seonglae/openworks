/** Provider-neutral, side-effect-free content boundaries. No platform or SDK imports. */
export type ContentSource =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly url: string; readonly text?: string }
  | { readonly kind: "paper"; readonly reference: string; readonly text?: string }
  | { readonly kind: "screenshot"; readonly imageRef: string; readonly extractedText?: string };

export interface Content {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly source: ContentSource;
  /** Missing OCR/full text is not silently promoted to verified content. */
  readonly completeness: "reference-only" | "text-available";
  readonly processing: readonly { readonly processor: string; readonly operation: string }[];
}
export type ContentList = readonly Content[];
export interface InputAdapter<T> {
  readonly stage: "input";
  readonly name: string;
  capture(input: T): ContentList;
}
export interface ProcessingAdapter {
  readonly stage: "processing";
  readonly name: string;
  process(contents: ContentList): ContentList;
}
export interface OutputAdapter<T> {
  readonly stage: "output";
  readonly name: string;
  prepare(contents: ContentList): T;
}

/** A stage-discriminated union, with each boundary retaining its own contract. */
export type ContentAdapter<TInput = unknown, TOutput = unknown> =
  InputAdapter<TInput> | ProcessingAdapter | OutputAdapter<TOutput>;

export function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value;
}

function record(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${field}`);
}

function optionalText(value: unknown): string | undefined {
  if (value !== undefined && typeof value !== "string") throw new Error("source text must be a string");
  return value as string | undefined;
}

function snapshotSource(source: unknown): ContentSource {
  record(source, "content source");
  switch (source.kind) {
    case "text":
      return Object.freeze({ kind: "text", text: nonempty(source.text, "text") });
    case "link":
      return Object.freeze({ kind: "link", url: nonempty(source.url, "url"), text: optionalText(source.text) });
    case "paper":
      return Object.freeze({
        kind: "paper",
        reference: nonempty(source.reference, "paper reference"),
        text: optionalText(source.text),
      });
    case "screenshot":
      return Object.freeze({
        kind: "screenshot",
        imageRef: nonempty(source.imageRef, "image reference"),
        extractedText: optionalText(source.extractedText),
      });
    default:
      throw new Error("unsupported content source");
  }
}

/** Snapshot every nested record so callers cannot mutate another stage's inputs. */
export function contentList(contents: ContentList): ContentList {
  if (!Array.isArray(contents)) throw new Error("contents must be an array");
  const ids = new Set<string>();
  return Object.freeze(
    Array.from(contents, (item): Content => {
      record(item, "content");
      const id = nonempty(item.id, "content id");
      if (ids.has(id)) throw new Error("duplicate content id");
      ids.add(id);
      if (typeof item.title !== "string") throw new Error("content title must be a string");
      if (typeof item.text !== "string") throw new Error("content text must be a string");
      const source = snapshotSource(item.source);
      const sourceText = source.kind === "screenshot" ? source.extractedText : source.text;
      const completeness: Content["completeness"] = sourceText?.trim() ? "text-available" : "reference-only";
      if (item.completeness !== completeness) throw new Error("content completeness must match source evidence");
      if (completeness === "reference-only" && item.text.trim())
        throw new Error("reference-only content cannot contain working text");
      if (!Array.isArray(item.processing)) throw new Error("content processing must be an array");
      return Object.freeze({
        id,
        title: item.title,
        text: item.text,
        source,
        completeness,
        processing: Object.freeze(
          Array.from(item.processing, (step) => {
            record(step, "processing step");
            return Object.freeze({
              processor: nonempty(step.processor, "processor"),
              operation: nonempty(step.operation, "operation"),
            });
          }),
        ),
      });
    }),
  );
}
