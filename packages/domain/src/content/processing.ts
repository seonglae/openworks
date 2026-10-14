import { contentList, nonempty } from "./contracts.ts";
import type { Content, ProcessingAdapter } from "./contracts.ts";

/** Inject a pure text transform; source evidence and identity remain unchanged. */
export function textProcessor(
  name: string,
  operation: string,
  transform: (content: Content) => string,
): ProcessingAdapter {
  nonempty(name, "processor");
  nonempty(operation, "operation");
  return {
    stage: "processing",
    name,
    process(contents) {
      return contentList(
        contentList(contents).map((content) => {
          // Reference-only inputs cannot be summarized as if their content was read.
          if (content.completeness === "reference-only") return content;
          const text = transform(content);
          // Runtime callers can bypass TypeScript, including by passing an async
          // callback. Never let a Promise or another non-text value reach exports.
          if (typeof text !== "string") throw new Error("processing result must be a string");
          return {
            ...content,
            text,
            processing: [...content.processing, { processor: name, operation }],
          };
        }),
      );
    },
  };
}
