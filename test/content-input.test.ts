import { expect, it } from "vitest";
import { captureJobContent } from "../scripts/content-input.mts";

it("adapts legacy paper jobs without changing their schema", () => {
  const job = { _id: "j", type: "paper", url: "doi:sample", content: "paper" };
  expect(captureJobContent(job)[0]).toMatchObject({ id: "j", source: { kind: "paper", reference: "doi:sample" } });
  expect(job.content).toBe("paper");
});
it("retains every screenshot alongside pasted content", () => {
  const list = captureJobContent({ _id: "j", imagePath: "a.png", imagePaths: ["a.png", "b.png"], content: "note" });
  expect(list.map((item) => item.source.kind)).toEqual(["screenshot", "screenshot", "text"]);
  expect(new Set(list.map((item) => item.id)).size).toBe(3);
});
it("supports the original single-image job", () => {
  expect(captureJobContent({ _id: "j", imagePath: "a.png" })[0].source).toEqual({
    kind: "screenshot",
    imageRef: "a.png",
  });
});
it("leaves source-less jobs and whitespace-only pasted input empty", () => {
  expect(captureJobContent({ _id: "j" })).toEqual([]);
  expect(captureJobContent({ _id: "j", content: "  " })).toEqual([]);
});
it("keeps a URL and its supplied content in one source record", () => {
  expect(
    captureJobContent({ _id: "j", type: "article", url: "https://example.com", content: "article" })[0],
  ).toMatchObject({ source: { kind: "link", url: "https://example.com", text: "article" } });
});
