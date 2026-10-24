import { useMutation } from "convex/react";
import { X } from "lucide-react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { UniversalInput } from "../../views/JobsView";
import { useDialog } from "./useDialog";
import { CAPTURE_KINDS, guessKind, type CaptureKind } from "./capture";

export type CaptureSeed = { text?: string; files?: File[] };

export function CaptureSheet({
  seed,
  defaultKind,
  onClose,
  onDone,
}: {
  seed: CaptureSeed;
  defaultKind: CaptureKind;
  onClose: () => void;
  onDone: (kind: CaptureKind) => void;
}) {
  const dialogRef = useDialog(onClose);
  const [kind, setKind] = useState<CaptureKind>(() => guessKind(seed.text ?? "", defaultKind));
  const createJob = useMutation(api.jobs.create);
  const jobUploadUrl = useMutation(api.jobs.generateUploadUrl);
  const addInsight = useMutation(api.insights.add);
  const addInsightImage = useMutation(api.insights.addImage);
  const insightUploadUrl = useMutation(api.insights.generateUploadUrl);

  const upload = async (uploadUrl: string, file: File) => {
    const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return ((await res.json()) as { storageId: Id<"_storage"> }).storageId;
  };

  const submit = async (input: string, images?: File[]) => {
    if (kind === "insight") {
      for (const file of images ?? [])
        await addInsightImage({ imageId: await upload(await insightUploadUrl({}), file) });
      if (input) await addInsight({ raw: input });
    } else {
      const imageIds: Id<"_storage">[] = [];
      for (const file of images ?? []) imageIds.push(await upload(await jobUploadUrl({}), file));
      const tokens = input.split(/[\s,]+/).filter(Boolean);
      if (imageIds.length === 0 && tokens.length > 1 && tokens.every((t) => /^https?:\/\//i.test(t))) {
        for (const url of tokens) await createJob({ url, type: kind });
      } else {
        const isUrl = /^https?:\/\//i.test(input);
        await createJob({
          ...(isUrl ? { url: input } : { url: "", ...(input ? { content: input } : {}) }),
          type: kind,
          ...(imageIds.length > 0 ? { imageIds } : {}),
        });
      }
    }
    onDone(kind);
  };

  const current = CAPTURE_KINDS.find((k) => k.key === kind)!;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/30 sm:items-start sm:pt-[12vh]"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Add"
        className="glass-strong w-full max-w-xl max-h-[85dvh] overflow-y-auto rounded-t-2xl p-4 sm:rounded-2xl [&_form]:mb-0"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex flex-wrap items-center gap-1">
          {CAPTURE_KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={kind === k.key}
              onClick={() => setKind(k.key)}
              className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
                kind === k.key ? "bg-rust-dim font-medium text-rust" : "text-ink-3 hover:text-ink"
              }`}
            >
              {k.label}
            </button>
          ))}
          <button type="button" onClick={onClose} className="ml-auto p-1 text-ink-3 hover:text-ink" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <UniversalInput
          placeholder={current.placeholder}
          onSubmit={submit}
          allowImage
          initialText={seed.text}
          initialFiles={seed.files}
        />
      </div>
    </div>
  );
}
