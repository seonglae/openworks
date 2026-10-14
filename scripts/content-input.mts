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
  if (job.type === "paper" && (job.url || job.content)) {
    inputs.push({ id, title, source: { kind: "paper", reference: job.url || job.content!, text: job.content } });
  } else if (job.url) {
    inputs.push({ id, title, source: { kind: "link", url: job.url, text: job.content } });
  } else if (job.content?.trim()) {
    inputs.push({ id, title, source: { kind: "text", text: job.content } });
  }
  return contentInput.capture(inputs);
}
