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

So the claim is deliberately one-way. A period whose row exists is never
claimed again, whatever state that row is in: two workers waking at the same
hour, one wins and the other mails nothing, and a worker that dies mid-send
leaves a row that no later run will retake.

That trade is not free. A crash between claiming and sending burns the period,
and the digest for it never goes out. It is the right way round, because a
skipped digest is recoverable by looking at the app and a duplicate in an inbox
is not, but it does mean a missing mail is worth checking the row for rather
than assuming the send is broken.

## Styling

Inline styles, not a stylesheet: enough mail clients drop `<style>` blocks that
a hoisted class arrives as unformatted text. Figures are table cells and
background colours rather than SVG, because a chart that renders in a browser
does not survive an inbox.

Gmail stops rendering near 102KB and hides the rest behind "View entire
message", so whatever came last would silently vanish. Both MIME parts are
base64, which inflates the source by about a third, so the body budget is 72KB.
The digest trims itself to that and says what it dropped, rather than letting
the mail client decide.

## When it is due

A daily covers yesterday in full, which is why it goes out in the morning
rather than at midnight: nothing is still being written into the day it
reports. A Monday morning is both a daily morning and a weekly one, and each is
claimed separately, so one already sent does not suppress the other.
