import { MdNotion } from "../components/markdown";

function DiffSection({ text, variant }: { text: string | undefined; variant: "context" | "add" }) {
  if (!text?.trim()) {
    return (
      <div className="px-3 py-1 bg-paper-warm/30">
        <span className="mono text-[11px] text-ink-4">···</span>
      </div>
    );
  }
  const bg = variant === "add" ? "bg-sage-dim" : "bg-paper-warm/30";
  const border = variant === "add" ? "border-l-2 border-sage" : "";
  const prefix = variant === "add" ? "+" : " ";
  const prefixColor = variant === "add" ? "text-sage" : "text-ink-4";
  const textColor =
    variant === "add"
      ? "[&_a]:text-rust [&_h1]:serif [&_h2]:serif [&_h3]:serif"
      : "text-ink-3 [&_a]:text-ink-3 [&_h1]:text-ink-3 [&_h2]:text-ink-3 [&_h3]:text-ink-3 [&_p]:text-ink-3";
  return (
    <div className={`flex ${bg} ${border}`}>
      <span className={`shrink-0 w-6 text-center mono text-xs leading-6 select-none ${prefixColor}`}>{prefix}</span>
      <div className={`flex-1 min-w-0 px-2 py-1 prose prose-sm max-w-none break-words ${textColor}`}>
        <MdNotion>{text}</MdNotion>
      </div>
    </div>
  );
}

export function DiffBlock({
  contextBefore,
  content,
  contextAfter,
}: {
  contextBefore?: string;
  content: string;
  contextAfter?: string;
}) {
  return (
    <div className="mt-2 border border-rule overflow-hidden text-sm">
      <DiffSection text={contextBefore} variant="context" />
      <DiffSection text={content} variant="add" />
      <DiffSection text={contextAfter} variant="context" />
    </div>
  );
}
