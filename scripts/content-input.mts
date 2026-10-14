import { contentInput, type ContentList } from "@openworks/domain";

/** Bridge the legacy job schema into the canonical, independent input contract. */
export interface IntakeJob {
  _id: string;
  type?: string;
  title?: string;
  url?: string;
  content?: string;
  imagePath?: string;
  imagePaths?: readonly string[];
}
export function captureJobContent(job: IntakeJob): ContentList {
  const id = String(job._id);
  const title = job.title;
  // Preserve image evidence even when a canonical URL or pasted text accompanies it.
  const inputs: Parameters<typeof contentInput.capture>[0][number][] = [];
  const images = job.imagePaths?.length ? job.imagePaths : job.imagePath ? [job.imagePath] : [];
  images.forEach((imageRef, index) =>
    inputs.push({ id: `${id}:image:${index}`, title, source: { kind: "screenshot", imageRef } }),
  );
  const url = job.url?.trim();
  const content = job.content?.trim() ? job.content : undefined;
  // A pasted paper has no locator of its own; its body is the text, and the job
  // is what points at it.
  if (job.type === "paper" && (url || content)) {
    inputs.push({ id, title, source: { kind: "paper", reference: url || `job:${id}`, text: content } });
  } else if (url) {
    inputs.push({ id, title, source: { kind: "link", url, text: content } });
  } else if (content) {
    inputs.push({ id, title, source: { kind: "text", text: content } });
  }
  return contentInput.capture(inputs);
}
