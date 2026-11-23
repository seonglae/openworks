import { describe, expect, it } from "vitest";
import { feedCard } from "../src/feedCard.ts";

const types = (blocks: { type: string }[] | undefined) => blocks?.map((b) => b.type);

describe("a feed card's composition", () => {
  it("lays a paper out as its figure, its argument in role order ending on the takeaway, one edit and the rest behind Open", () => {
    const card = feedCard(
      {
        kind: "job",
        title: "A paper",
        subtitle: "Paper",
        jobId: "j1",
        notion: 3,
        figure: { url: "https://x/fig.png", width: 1600, height: 900, caption: "arXiv caption" },
        image: "https://x/source.png",
        visualCaption: "what the figure shows",
        roles: {
          insight: "so this",
          problem: "it breaks",
          result: "it works",
          observation: "mostly",
          solution: "do that",
        },
      },
      "ko",
    );
    expect(types(card)).toEqual(["header", "figure", "roles", "diffs", "actions"]);
    expect(card![1]).toMatchObject({ caption: "what the figure shows", minRatio: 0.6 });
    const roles = card!.find((b) => b.type === "roles");
    expect(roles).toMatchObject({
      items: [
        { label: "문제", text: "it breaks", lines: 12 },
        { label: "방법", text: "do that" },
        { label: "결과", text: "it works mostly", lines: 12 },
        { label: "통찰", text: "so this", color: "#E0457B" },
      ],
    });
    expect(card!.find((b) => b.type === "diffs")).toEqual({
      type: "diffs",
      label: "수정 제안 3건",
      show: 1,
      total: 3,
      maxLines: 4,
      more: "나머지 2건은 열어서 보기",
    });
    expect(card!.at(-1)).toMatchObject({ items: [{ kind: "open" }, { kind: "archive" }] });
  });

  it("links an item to its original when it has one", () => {
    const card = feedCard(
      {
        kind: "job",
        title: "An article",
        subtitle: "Article",
        jobId: "j3",
        inputSource: { url: "https://a.example/post" },
      },
      "ko",
    );
    expect(card!.at(-1)).toMatchObject({
      items: [{ kind: "open" }, { kind: "source", label: "원문", url: "https://a.example/post" }, { kind: "archive" }],
    });
  });

  it("gives an insight its interpretation as a quote, its one placement and a dismiss, in English when asked", () => {
    const card = feedCard(
      {
        kind: "insight",
        title: "주는 것에 만족할 줄 아는 사람",
        lines: ["주는 것에 만족할 줄 아는 사람", "Someone content to give"],
        insightId: "i1",
        place: { pageName: "Aphorism", content: "> 주는 것" },
      },
      "en",
    );
    expect(types(card)).toEqual(["header", "quote", "diffs", "actions"]);
    expect(card![2]).toMatchObject({ label: "1 edit", show: 1, total: 1 });
    expect(card![2]).not.toHaveProperty("more");
    expect(card!.at(-1)).toEqual({ type: "actions", items: [{ kind: "dismiss", label: "Dismiss", icon: "xmark" }] });
  });

  it("keeps a screenshot at full size and an article's summary beside its edits", () => {
    const base = {
      kind: "job",
      title: "An article",
      subtitle: "Article",
      jobId: "j2",
      image: "https://x/s.png",
      lines: ["a", "b"],
    };
    const full = feedCard({ ...base, notion: 0 }, "en");
    const compact = feedCard({ ...base, notion: 2 }, "en");
    expect(types(full)).toEqual(["header", "image", "text", "text", "actions"]);
    expect(full?.find((b) => b.type === "image")).toMatchObject({ height: 280 });
    expect(types(compact)).toEqual(["header", "image", "text", "text", "diffs", "actions"]);
    expect(compact?.find((b) => b.type === "image")).toMatchObject({ height: 280 });

    expect(types(feedCard(base, "en", 0))).not.toContain("image");
    expect(types(feedCard({ ...base, notion: 2 }, "en", 0))).not.toContain("image");
  });

  it("makes no card for what is not a job or an insight", () => {
    expect(feedCard({ kind: "video", title: "A short" }, "ko")).toBeUndefined();
  });
});
