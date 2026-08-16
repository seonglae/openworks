// The PR list state, split out of PRView so that file exports only its
// component and stays Fast Refreshable.
import { useState, useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";

export type PR = {
  id: number;
  repo: string;
  repoUrl: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorAvatar: string;
  labels: string[];
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  comments: number;
  checksPass: number;
  checksTotal: number;
  checksState: "success" | "failure" | "pending" | "none" | "loading";
  mergeable: boolean | null;
  behindBy: number;
  changedFiles: number;
  commits: number;
  additions: number;
  deletions: number;
  branch: string;
};

export function usePRData() {
  const fetchPRs = useAction(api.github.listOpenPRs);
  const fetchPRDetails = useAction(api.github.listPRDetails);
  const [grouped, setGrouped] = useState<Record<string, PR[]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    let data: Record<string, PR[]> | null = null;
    try {
      data = (await fetchPRs({})) as Record<string, PR[]>;
      setGrouped(data);
      setLoaded(true);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
    // Second pass, after the list is on screen: mergeable / diffstat / branch
    // each cost a per-PR request against GitHub, and none of them is worth
    // holding the list back for.
    if (!data) return;
    const prs = Object.values(data)
      .flat()
      .map((p) => ({ repo: p.repo, number: p.number }));
    if (prs.length === 0) return;
    try {
      const details = await fetchPRDetails({ prs });
      const byKey = new Map(details.map((d) => [`${d.repo}#${d.number}`, d]));
      setGrouped((prev) => {
        if (!prev) return prev;
        const next: Record<string, PR[]> = {};
        for (const [repo, list] of Object.entries(prev)) {
          next[repo] = list.map((p) => {
            const d = byKey.get(`${p.repo}#${p.number}`);
            return d ? { ...p, ...d } : p;
          });
        }
        return next;
      });
    } catch (e) {
      console.error(e);
    }
  }, [fetchPRs, fetchPRDetails]);

  const removePR = useCallback((repo: string, prId: number) => {
    setGrouped((prev) => {
      if (!prev) return prev;
      const updated = { ...prev };
      if (updated[repo]) {
        updated[repo] = updated[repo].filter((p) => p.id !== prId);
        if (updated[repo].length === 0) delete updated[repo];
      }
      return updated;
    });
  }, []);

  return { grouped, loading, loaded, load, removePR };
}
