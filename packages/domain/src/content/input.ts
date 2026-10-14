import { contentList, nonempty } from "./contracts.ts";
import type { Content, ContentList, ContentSource, InputAdapter } from "./contracts.ts";

export interface ContentInput {
  readonly id: string;
  readonly title?: string;
  readonly source: ContentSource;
}

export const contentInput: InputAdapter<readonly ContentInput[]> = {
  stage: "input",
  name: "content",
  capture(inputs): ContentList {
    return contentList(
      inputs.map(({ id, title, source }): Content => {
        if (!source || typeof source !== "object") throw new Error("invalid content source");
        if (title !== undefined && typeof title !== "string") throw new Error("title must be a string");
        let text: string;
        switch (source.kind) {
          case "text":
            text = nonempty(source.text, "text");
            break;
          case "link":
            nonempty(source.url, "url");
            text = optionalText(source.text);
            break;
          case "paper":
            nonempty(source.reference, "paper reference");
            text = optionalText(source.text);
            break;
          case "screenshot":
            nonempty(source.imageRef, "image reference");
            text = optionalText(source.extractedText);
            break;
          default:
            return assertNever(source);
        }
        return {
          id,
          title: title ?? id,
          source,
          text,
          completeness: text.trim() ? "text-available" : "reference-only",
          processing: [],
        };
      }),
    );
  },
};

function optionalText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("source text must be a string");
  return value;
}

function assertNever(value: never): never {
  void value;
  throw new Error("unsupported content source");
}

export const screenshotInput: InputAdapter<{
  readonly id: string;
  readonly imageRef: string;
  readonly title?: string;
  readonly extractedText?: string;
}> = {
  stage: "input",
  name: "screenshot",
  capture: ({ id, title, imageRef, extractedText }) =>
    contentInput.capture([{ id, title, source: { kind: "screenshot", imageRef, extractedText } }]),
};

export const paperInput: InputAdapter<{
  readonly id: string;
  readonly reference: string;
  readonly title?: string;
  readonly text?: string;
}> = {
  stage: "input",
  name: "paper",
  capture: ({ id, title, reference, text }) =>
    contentInput.capture([{ id, title, source: { kind: "paper", reference, text } }]),
};
