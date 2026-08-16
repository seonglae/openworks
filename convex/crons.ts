import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Once a day, poll every enabled RSS/Atom feed and auto-register new items as
// `article` jobs (the worker then summarizes them). 21:00 UTC = ~06:00 KST.
crons.daily("poll rss feeds", { hourUTC: 21, minuteUTC: 0 }, internal.feeds.pollAll, {});
// Strip re-fetchable arXiv full text from the day's finished paper jobs; the
// summaries/scores/chat stay, the raw content is replaced by a source marker.
crons.daily("strip arxiv paper content", { hourUTC: 21, minuteUTC: 30 }, internal.cleanup.stripDaily, {});

export default crons;
