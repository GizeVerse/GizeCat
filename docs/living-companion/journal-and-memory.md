# Journal and memory

Status: IMPLEMENTED and statically verified (type-check, lint, read-only review). NOT RUN: the journal has never been written, saved, loaded or cleared by a running build of 1.5.0. Everything below is read from `src/shared/catState.ts`, `src/core/behavior/worldMemory.ts`, `src/core/behavior/simCompanion.ts`, `src/shared/worldText.ts`, `src/shared/profileTransfer.ts` and the settings pages.

Back to the [overview](README.md).

The Cat Journal is a quiet diary of small moments in your cat's life. It is local, bounded and clearable. It has no streaks, no scores and no reminders, and it never notifies you.

## What is stored

The persisted cat gets one new section, `world` (the "world memory"). It is additive: no schema version bump. A cat saved before 1.5.0 has no `world` and loads an empty one. A build that does not know the section drops it on its next save, which only forgets the diary.

| Field | What it holds | Bound |
|---|---|---|
| `events` | The events that ended recently: event id, the wall-clock time it ended, and a short outcome token. It feeds the repetition control of the scheduler. | The newest 16 (`EVENT_HISTORY_MAX`). |
| `counts` | How many times each event has finished (including events that were cut short or went unnoticed). It gives the cat a sense of novelty: an unseen event is picked a little more often and noticed a little sooner than a very familiar one (see [World events](events.md#personality-and-novelty)). The repetition control still uses `events`. The engine reads the counts when the cat is loaded, replaced or cleared, and the sim saves them through the same history append as before. | Whole numbers up to 1,000,000 per event; known event ids only. |
| `lastEndedAt` | Wall-clock time the last event ended (0 if none). The schedule restarts from a fresh delay anyway. | One number, in the range a date can show. |
| `journal` | The diary: meaningful moments, newest last. Same shape as an `events` entry. | The newest 60 (`JOURNAL_MAX`). |

An entry is only three things: an event id from the catalogue, a time, and an outcome token (lower-case letters, digits and underscores, 1 to 24 characters, for example `chased` or `rested_beside`). The sentence you read is built from the id and the token when it is displayed (`journalText` in `worldText.ts`); no sentence, no text of yours and nothing typed is ever stored. The date is shown as `YYYY-MM-DD` in your local time.

What the journal does not hold: the screen, window titles, the pointer position, file names, anything you typed, or any location. Perception data never enters the cat's memory.

### Which moments are written

An event writes a journal line only when its outcome is marked as worth one in the catalogue (the asterisks in [World events](events.md#the-26-events)). Outcomes such as `cut` (the event was wound down while its props were still on screen) and `unnoticed` are never journalled. A line is written only when "Keep a journal" is on. With it off, nothing new is written, existing lines stay until you clear them, and the short event history and counters are still kept (they steer which events play and how new each one feels, not what you read).

### Bounds and safety on load

Every list is checked entry by entry (`src/shared/catState.ts`): an entry with an unknown event id, a bad time or a bad outcome token is dropped and never costs the others. Only the last 1,024 items of a list are even looked at, so a hand-edited file cannot make loading slow. Counters are clamped. The file itself is protected by the cat store's atomic write, backup and quarantine (`catStore.ts`, `jsonStore.ts`).

## Where it is stored

| Platform | Where |
|---|---|
| Windows | `cat-state.json` in the app's user data folder (`src/main/app.ts`), with the rest of the cat. |
| Android and the web host | The app's private browser storage on the device, under the key `gizecat.web.cat.v1` (`src/web/storage.ts`). On Android it lives in the app's private storage; uninstalling the app or clearing its data deletes it. |

It is never uploaded, synced or sent anywhere. There is no network code in this feature.

## How to read, switch off and clear it

- **Read:** Windows, the Journal page; Android, the Journal section of the home panel (newest first). While the Android floating cat runs, its own page owns the cat, so the panel shows what the floating cat last saved.
- **Switch off:** "Keep a journal" on the same page or section. Stored in `settings.companion.journal.enabled` (default on).
- **Clear:** the "Clear journal" button, which asks you to confirm. In the code this forgets the whole world memory: every journal entry, the short event history and the per-event counters, and it ends any running event (`clearJournal` calls `forgetWorld` in `simCompanion.ts`). Both the Windows page (description and confirmation) and the Android panel's confirmation say so plainly: the entries, the short event history and the event counters the cat uses to tell familiar events from new ones are deleted, and every event feels new to the cat again. Nothing else about the cat changes: its traits, stats and learned preferences stay.
  - On Android the panel cannot clear it while the floating cat is running (it would not be the page that owns the cat); stop the floating cat first.
- **Clear history** (Personality page on Windows) also forgets the world, together with the learned memory. Resetting the personality (a new cat) and adopting a different cat through a profile import give the new cat an empty world, because the journal belongs to the cat it was written for. On Android and the web host, "Start over" removes the stored cat and settings.

## What is never exported

A saved profile (the character file you can move to another device) carries the choices, not the diary. The profile policy classifies the whole `world` section as `never` (`PROFILE_CAT_POLICY.world` in `profileTransfer.ts`, exhaustive at compile time: a persisted field added later fails to type-check until someone classifies it). What does travel is the `companion` settings: the personality, the event choices (on or off, rare, pace, individual switches), reduced motion, and the "Keep a journal" switch. A copied cat starts a fresh journal. A search of `src/main/diagnostics` finds no reference to the journal, so the diagnostics export does not include it either (a static reading, not a run).

## No notifications, no streaks

- The journal never raises a notification, a badge, a sound or a reminder. It appears only when you open the page.
- There are no streaks, no counts of "days in a row", no scores and no goals. The count shown on the page is just the number of entries kept.
- The tone is fixed in `worldText.ts`: warm and quiet, no exclamation marks, no guilt.
- Android's `POST_NOTIFICATIONS` permission is for the floating cat's service notification (Pause, Hide, Stop), as documented in [the Android overlay guide](../platforms/android-overlay.md); the journal and the world events do not use it.

## Where it is pinned

Written and NOT RUN: `tests/unit/core/behavior/worldMemory.test.ts` (append, bounds, clear), `tests/unit/shared/profileTransfer.test.ts` (the policy), `tests/unit/shared/companionSettings.test.ts` (the settings section), `tests/unit/renderer/settings/companionPages.test.ts` (the pages), `tests/unit/core/events/catalog.test.ts` (outcome tokens against the text table) and `tests/unit/main/catStore.test.ts` (persistence).
