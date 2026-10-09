# CLAUDE.md

Guidance for any Claude Code session working on this repo. This app has hit
Firebase's free-tier (Spark) daily read/write limits multiple times — each
time from a different, well-intentioned piece of code that didn't know about
the limit. Read this before adding anything that reads or writes Firestore,
especially anything meant to auto-refresh or feel "live."

## What this app is

A single-page app (`index.html`, no build step) for SPX's SOC supplies/asset
management, backed directly by Cloud Firestore with no backend server — the
browser talks to Firestore straight from client JS (`window.storage`,
defined near the top of `index.html`). It's on the **free Spark plan**:
50,000 reads/day, 20,000 writes/day, 20,000 deletes/day, project-wide. There
is no backend to absorb a mistake — a chatty client directly costs the whole
project's daily quota, and exceeding it has caused real outages (the app and
the SeaTalk bot both stop working until the next day's quota resets).

## Rule #1: Live data must use listeners, not polling

**Never use `setInterval` (or a scan a "Refresh current data" button fires
automatically) to repeatedly re-read Firestore.** This has caused three
separate outages/near-outages in this app's history, each time from
different code:
1. The original cross-tab sync polled every 4 seconds, unconditionally, in
   every open tab — any 2-3 people leaving a tab open all day blew the daily
   quota from idle reads alone.
2. After that was fixed, a brand-new dashboard/cage-loading status feature
   independently re-added a 4-second poll, because it didn't know the first
   one had ever been a problem.
3. (Not caused by polling, but related: individual Firestore documents and
   commits also have hard size limits — see "Data architecture" below.)

**The fix is always the same shape**: use `window.storage.subscribe(key,
shared, onValue, onError)` instead of `setInterval` + `window.storage.get`/
`loadSections`. `subscribe` opens a Firestore listener, which only bills a
read for its *initial attach* and for *actual changes* to that document —
not on a fixed clock. A screen nobody is touching costs ~0 reads/hour
instead of ~900 reads/hour (at a 4s poll) or ~120/hour (at a 30s poll).
Polling can *feel* cheaper when you pick a long interval, but it never gets
to zero, and "everyone forgot this screen is cheap to poll a little" is
exactly how outage #2 above happened.

**Required lifecycle for any listener you add:**
- Only attach it while the screen that needs it is actually visible (check
  the current `route`, like `startDashboardLiveSync()`/`startCageLiveSync()`
  in `index.html` do).
- Detach it (call the unsubscribe function `subscribe()` returns) the moment
  that screen is no longer visible: on navigating away, and on
  `visibilitychange` when the tab is hidden. See
  `syncLiveListenersForVisibility()` in `index.html` — it's called from
  `navigate()` on every route change and from a `document.visibilitychange`
  listener, and is the pattern to extend for a new auto-refreshing screen,
  not a new one-off timer.
- Guard the callback against re-entrancy and against firing after the
  screen's already gone (see the `actionInFlight`/`route!==X` checks inside
  the existing `subscribe()` callbacks for the pattern).

`scripts/test-live-listener-lifecycle.js` enforces the "no `setInterval`,
`subscribe` must exist, `visibilitychange` must exist" part of this
mechanically — if you add a poll loop, that test will fail. Don't delete or
weaken that test to make new code pass; fix the new code instead.

## Data architecture: why some sections are "records" and some are a blob

`RECORD_SECTION_KEYS` in `index.html` (`requests`, `returns`, `issuance`,
`receiving`, `repairs`) are stored as **one Firestore document per record**
(e.g. `pilot_v2_requests/REQ-123`), not as one big JSON blob. Every other
top-level field in the app's data (`users`, `sku`, `stock`, `cages`, etc.) is
still a single document per section (`sms_erp_storage/shared__pilot_v2__section__<key>`).

**Why it matters:** Firestore caps a single document at ~1MiB and a single
commit (transaction or batch) at ~10MiB total, no matter how many documents
it touches. A blob section that keeps growing (more history, embedded
file attachments as base64) will eventually hit one of those limits and
start failing *every* save to it outright — this already happened twice
(`requests` in September, `receiving` in October, both while still a single
blob; both fixed by moving to one-document-per-record).

**If a blob section (anything not in `RECORD_SECTION_KEYS`) starts
accumulating a lot of records or large embedded data (file uploads,
attachments, growing history)**, the fix is to migrate it to
`RECORD_SECTION_KEYS` the same way `receiving`/`repairs` were (see that
commit's message and `scripts/migrate-receiving-repairs.js` for the
one-time migration pattern) — not to just hope it stays small, and not to
"optimize" the blob in place.

**`window.storage.setMulti()`** (the function behind every save) already
protects against a single save exceeding the 10MiB commit limit by spending
a byte budget across multiple sequential commits instead of one. That's a
safety net for saves that touch a lot of data at once — it is not a reason
to be careless about how much data a single save touches; fewer, smaller
writes are always better than relying on the split.

## Before adding anything that reads or writes Firestore

- **Auto-refreshing a screen?** Use a listener (`window.storage.subscribe`),
  attached/detached on route visibility — not a timer. See Rule #1.
- **Adding a new collection of records that will grow over time** (receipts,
  logs, history, anything with a user-uploaded file attached)? Put it in
  `RECORD_SECTION_KEYS` from the start — one document per record — not as
  a growing array inside one of the existing blob sections.
- **Not sure if something you're adding will read/write a lot?** Check the
  actual usage after shipping it: Firebase console → Firestore → Usage tab.
  The "Reads" graph should be flat/bursty-with-real-activity, never a
  smooth, ever-rising line all day — a smooth rising line is the signature
  of a poll running regardless of whether anyone's using the app.
- **Run `node scripts/test-live-listener-lifecycle.js`** (and the other
  `scripts/test-*.js` files) before pushing a change to any of this —
  they're fast, no setup required, and exist specifically to catch the
  mistakes this file describes.
