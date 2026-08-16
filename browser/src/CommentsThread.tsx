// CommentsThread — polymorphic comments UI for any research entity.
// Renders a flat list with thread indentation and a post box. When auth is
// disabled (no Clerk pubkey), the post box is hidden and only existing
// comments render (read-only mode for dev / public preview).

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Md } from "./components/markdown";
import type { AuthorType, EntityType } from "@openworks/domain";

const AUTH_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

type Props = {
  researchSlug: string;
  targetType: EntityType;
  targetKey: string;
  targetVenueSlug?: string;
};

type CommentDoc = {
  _id: Id<"comments">;
  researchSlug: string;
  targetType: EntityType;
  targetKey: string;
  targetVenueSlug?: string;
  parentId?: Id<"comments">;
  authorType: AuthorType;
  authorId: string;
  authorName?: string;
  body: string;
  deleted?: boolean;
  editedAt?: number;
  createdAt: number;
  updatedAt: number;
};

type Tree = (CommentDoc & { replies: Tree })[];

function buildTree(flat: CommentDoc[]): Tree {
  const byId = new Map(flat.map((c) => [c._id, { ...c, replies: [] as Tree }]));
  const roots: Tree = [];
  for (const c of byId.values()) {
    if (c.parentId && byId.has(c.parentId)) {
      byId.get(c.parentId)!.replies.push(c);
    } else {
      roots.push(c);
    }
  }
  return roots;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function CommentNode({
  comment,
  depth,
  onReply,
}: {
  comment: CommentDoc & { replies: Tree };
  depth: number;
  onReply: (parentId: Id<"comments">) => void;
}) {
  const isAgent = comment.authorType === "agent";
  const indent = depth > 0 ? `ml-${Math.min(depth * 4, 12)}` : "";
  return (
    <div className={`pt-2 ${indent}`}>
      <div className="flex items-baseline gap-2 mono text-[10px] text-ink-4 mb-1">
        <span className={isAgent ? "text-rust" : "text-ink-2"}>{comment.authorName ?? comment.authorId}</span>
        <span>{isAgent ? "agent" : "user"}</span>
        <span>·</span>
        <span>{fmtTime(comment.createdAt)}</span>
        {comment.editedAt && <span>· edited</span>}
        {AUTH_ENABLED && (
          <button onClick={() => onReply(comment._id)} className="ml-auto hover:text-ink-2">
            reply
          </button>
        )}
      </div>
      {comment.deleted ? (
        <div className="text-ink-4 italic mono text-[11px]">[deleted]</div>
      ) : (
        <div className="text-ink-2 leading-relaxed prose prose-sm max-w-none [&_a]:text-rust">
          <Md>{comment.body}</Md>
        </div>
      )}
      {comment.replies.length > 0 && (
        <div className="border-l border-rule-light pl-3 mt-1">
          {comment.replies.map((r) => (
            <CommentNode key={r._id} comment={r} depth={depth + 1} onReply={onReply} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentsThread({ researchSlug, targetType, targetKey, targetVenueSlug }: Props) {
  const comments = useQuery(api.comments.listForTarget, {
    researchSlug,
    targetType,
    targetKey,
    targetVenueSlug,
    includeDeleted: true,
  }) as CommentDoc[] | undefined;
  const post = useMutation(api.comments.post);

  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<Id<"comments"> | null>(null);
  const [posting, setPosting] = useState(false);

  if (comments === undefined) {
    return (
      <div className="space-y-2 py-2" aria-busy="true">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex" style={{ justifyContent: i % 2 === 0 ? "flex-start" : "flex-end" }}>
            <div
              className="h-6 bg-paper-warm/60 animate-pulse rounded"
              style={{ width: `${50 - i * 10}%`, maxWidth: "70%" }}
            />
          </div>
        ))}
      </div>
    );
  }

  const tree = buildTree(comments);
  const total = comments.filter((c) => !c.deleted).length;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    try {
      // authorId & authorName come from Clerk's userIdentity on the server side
      // (we just pass placeholders; auth.ts in convex enforces the match).
      // For the user side we still need to send a value — Clerk's useUser hook
      // would supply it, but we read from window.Clerk to avoid an extra
      // dependency import here. If unavailable, prompt sign-in.
      const w = window as unknown as {
        Clerk?: { user?: { id: string; fullName?: string; primaryEmailAddress?: { emailAddress: string } } };
      };
      const u = w.Clerk?.user;
      if (!u) {
        alert("sign in required to comment");
        return;
      }
      await post({
        researchSlug,
        targetType,
        targetKey,
        targetVenueSlug,
        parentId: replyTo ?? undefined,
        authorType: "user",
        authorId: u.id,
        authorName: u.fullName ?? u.primaryEmailAddress?.emailAddress ?? "user",
        body: body.trim(),
      });
      setBody("");
      setReplyTo(null);
    } catch (err) {
      alert((err as Error).message ?? "post failed");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-rule-light">
      <div className="mono text-[10px] uppercase tracking-wider text-ink-4 mb-1">
        Comments {total > 0 && <span className="text-ink-3">({total})</span>}
      </div>
      {tree.length === 0 && <div className="mono text-[10px] text-ink-4 py-1">no comments yet</div>}
      {tree.map((c) => (
        <CommentNode key={c._id} comment={c} depth={0} onReply={setReplyTo} />
      ))}
      {AUTH_ENABLED && (
        <form onSubmit={handleSubmit} className="mt-3 space-y-1">
          {replyTo && (
            <div className="mono text-[10px] text-ink-4 flex items-center gap-2">
              replying to comment...
              <button type="button" onClick={() => setReplyTo(null)} className="text-ink-3 hover:text-ink-2">
                cancel
              </button>
            </div>
          )}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={replyTo ? "your reply (markdown ok)..." : "add a comment (markdown ok)..."}
            rows={2}
            className="w-full bg-paper-warm/30 border border-rule-light px-2 py-1 text-sm text-ink-2 placeholder:text-ink-4 outline-none focus:border-rust transition-colors"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={posting || !body.trim()}
              className="mono text-[10px] uppercase tracking-wider px-2 py-1 text-rust hover:bg-rust-dim disabled:text-ink-4 disabled:hover:bg-transparent transition-colors rounded-full"
            >
              {posting ? "posting..." : "post"}
            </button>
          </div>
        </form>
      )}
      {!AUTH_ENABLED && <div className="mono text-[10px] text-ink-4 mt-2 italic">sign-in disabled — read-only.</div>}
    </div>
  );
}
