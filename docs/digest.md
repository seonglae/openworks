# Digest

A daily and a weekly mail of what moved: what you archived, the papers you
scored, where each project sits, your open PRs, and a few words to study.

## What is in it

- **Archived and read**, with the delta against the previous window
- **Papers, articles and newsletters**, each a line, ordered by score
- **Recommendations** from the unarchived backlog, which is the part that says
  what to read next rather than what you already read
- **Research**, one line per project: what its agent reported today, or where
  it moved, or a stamped older report when neither happened
- **Open PRs**
- **Agent reports**, the rows filed by agents working in each project folder
- **Study today**, the vocabulary due

## Sending

The daily goes out at a configured hour; the weekly adds the sections that only
make sense over seven days. Delivery is through the `gws` CLI signed in as you,
so there is no mail provider to configure and no sending domain to warm up.

Set `OPENWORKS_DIGEST_TO` to enable it. Unset, no digest is ever sent.

## Sending exactly once

A send is claimed before it starts and marked as attempted before the mail
leaves. The distinction matters more than it looks: a run takes tens of minutes,
and a network failure between handing the mail to `gws` and recording the result
leaves a row that has no result but whose mail is already in your inbox.
Treating that row as "never sent" and retaking the period delivers the digest
twice.

So the claim protocol is deliberately asymmetric. A skipped digest is
recoverable; a duplicate in an inbox is not. A row that got as far as attempting
is never retaken, and a stale claim is only reclaimable after three hours, which
is longer than the longest observed run.

## Styling

Inline styles, not a stylesheet: enough mail clients drop `<style>` blocks that
a hoisted class arrives as unformatted text. Figures are table cells and
background colours rather than SVG, because a chart that renders in a browser
does not survive an inbox. The whole body is trimmed to stay inside Gmail's
102KB clipping limit.

A trend chart suppresses itself under three days of data, since the buckets are
UTC and a one-day local window straddles two of them.
