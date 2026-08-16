import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// The markdown lives in docs/ at the repo root, where whoever changes a
// feature is already working. The site renders it rather than keeping a
// second copy that drifts out of step with the code.
export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: "**/*.md", base: "../docs" }),
  }),
};
