# Lecture Notes

A study web app: record a lecture in the browser, get a transcript, notes and study tools, organized by course. Built for one person. This file is published with the site, so never put secrets or account details in it.

## Layout

There's no build step, framework or package manager. The site is plain browser JavaScript.

| File | Purpose |
|---|---|
| `index.html` | The whole app: CSS, markup and logic, all in one IIFE (about 4,700 lines) |
| `study-lib.js` | Stateless helpers on `window.studyLib`: passage search, spaced repetition, note parsing and rendering, audio slicing |
| `worker.js` | Cloudflare Worker: Gemini relay, R2 file access and background AI jobs |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | Installable app and offline loading |
| `*-config.js` | Public client config (Firebase, Supabase, Worker URL, R2 URL). Gemini's key is a Worker secret and is never in this repo |

Services: Firebase Auth and Firestore for data, Cloudflare R2 for files (Supabase holds only older files), Gemini for AI.

Find code by searching for function names. `index.html` is large, so read only the part you need.

## Deploying

- **Site:** GitHub Pages publishes `main` from the repo root, so merging to `main` goes live. A new root file the app needs at runtime must be pushed with `index.html`.
- **Worker:** `worker.js` in the repo isn't deployed automatically. Paste it into the Cloudflare dashboard editor and deploy. Deploy it before merging site changes that depend on it.
- **Schedule:** the Worker has a Cron Trigger running every minute, which finishes background jobs. In the dashboard, adding a trigger only creates a draft until **Save** is clicked. A new schedule can take several minutes to start.
- **Worker bindings:** `GEMINI_API_KEY` (secret) and `RECORDINGS_BUCKET` (R2).
- **Service worker:** app files are network-first, so deploys show up without changing the cache version.

## Data

**Firestore `courses/{courseId}`:** `name`, `code`, `term`, `createdAt`, `terms`, `flashcards`, `quiz`, `quizStats`, `tutorChat`, `sections` (`[{id, name}]`), `liveRecordings` (session IDs), `pendingJobs` (entry IDs).

**Firestore `courses/{courseId}/entries/{entryId}`:**
- All entries: `type` (`lecture`, `note` or `transcript`), `title`, `date`, `createdAt`, `notesText`, `transcript`, `slidePaths`, `sectionIds`
- Audio and timing: `audioPath`, `durationSec`, `segments` (`[{t, text}]`), `marks`
- Generated: `cleanTranscript`, `keyMoments`, `notesPdfPath`
- State: `previousTranscript`, `notesSummaryFailed`, `transcribeFailed`, `aiStale`

**R2 keys:**
- `<courseId>/<entryId>.<ext>`: recordings
- `slides/...` and `notes/...`: slides and notes PDFs
- `live/<courseId>/<sessionId>/`: crash backup, as `000000.webm` pieces and `session.json`
- `jobs/<courseId>/<entryId>.json`: background AI jobs
- `embeddings/<courseId>/<entryId>.json`: search-by-meaning vectors

A stored path starting with `r2:` is in R2, and one without it is in Supabase. Always go through `uploadFile`, `resolveFileUrl`, `removeFile` and `fetchStoredAudio`.

## How the main flows work

**Recording:** `beginCapture` runs one main `MediaRecorder` for the saved audio, plus AI clips every 35 seconds (`launchAiChunk`) for the real transcript. Browser speech recognition is only a live preview and a fallback. Every 10 seconds, audio is backed up to `live/` (`queueCloudChunk`, `saveRecordingSession`). Recordings aren't stored on the device, by the owner's choice.

**Saving:** `stopRecordingFlow` → `finalizeRecording` → `attemptSaveRecording` → `saveLectureJob` → `startLectureProcessing`. Entry IDs are chosen up front, so a retry overwrites instead of duplicating. A recording is locked to its starting course, and `blockedByRecording` stops navigation while one is busy.

**Recovery:** on load, `scanCloudRecordingsIfChanged` finds unfinished sessions listed in `liveRecordings`. Stopped ones finish on their own (`flushPendingRecordings`), and abandoned ones get a banner (`checkDraftRecovery`).

**AI after saving:** `enqueueLectureAi` creates a Worker job with four steps: summary, title, moments and cleanup. The Worker has no Firebase access, so results stay in R2 until the open app collects them (`watchJob`, `applyJobResults`). If queueing fails, `runLectureAi` does the work in the tab. A lecture with no transcript is first transcribed in the browser (`runAutoTranscribe`), because audio is split there, and its AI steps then run in the tab.

**Progress bar:** `startTracker`, `setTracker`, `setTrackerCloud`, `finishTracker`, `failTracker`. It must only say "safe to close" once closing can't lose anything. `saveInProgress` drives the close warning.

**AI answers:** `buildChat` → `searchTermsFor` and `meaningMatches` → `aiContextFor` → `askAIChat`, which streams. Context comes from `lib.buildAiContext`, with the best matches last and `[S1]` source tags, which `renderAnswer` makes clickable.

**Worker modes** (POST `body.mode`): `ask` (default), `chat`, `generate`, `transcribe`, `summarize`, `cleanup`, `studyguide`, `keymoments`, `searchterms`, `title`, `embed`, `enqueue`, `jobkick`. Files use GET `?file=`, PUT and DELETE with the `X-File-Path` header.

## Conventions

- Write ES5-style browser JavaScript in `index.html`: `var`, `function` and promise chains, matching the existing code.
- Build UI with `el()` and `text()`. Use `lib.renderNotes` for formatted text, because it can't inject HTML. Use `esc()` if a string must go into `innerHTML`.
- Keep user-facing text plain and specific, in the style of the existing messages.
- `index.html` uses CRLF line endings. Check what a file uses before scripting an edit.
- Colors come from the CSS variables on `:root`, with dark mode defined too. New CSS goes in the matching block near the end of the `<style>` tag.
- Support phone widths: no sideways scrolling, and nothing that depends on hover.

## Things that have caused trouble

- Background work must take an explicit `courseId`. The open course may have changed by the time it finishes.
- New site code must tolerate an older deployed Worker. An unknown mode falls through to `ask` and returns `Missing question`.
- The public R2 URL may not allow the browser to read files. `fetchStoredAudio` falls back to the Worker's `?file=` route.
- Recordings made in the browser may not report their length, so the audio player falls back to `durationSec`.
- Worker code must respect the Cloudflare free plan: 10 ms CPU per run, 50 subrequests, and 30 seconds of `waitUntil`. Long work belongs in resumable job steps that save progress.
- Retried job steps count their attempts before running and back off, so a failing step can't drain the Gemini quota.
- Model names change over time. Check Gemini's docs before changing `MODEL`, `ANSWER_MODEL`, `FALLBACK_MODEL` or `EMBED_MODEL`. The 2.5 models don't accept the `minimal` thinking level.

## Testing

There are no tests in this repo yet. Changes have been tested with Playwright in Chromium, using a fake microphone and fakes for Firebase, the Worker and storage, and blocking all other network traffic. Never test against the owner's real data without asking. Look at screenshots as well as running checks.

Playwright's request interception hides upload progress and large upload bodies, so test uploads against a real local server.

## Known gaps

- **Security:** the Worker has no login check, R2 files are public by URL, and all accounts read the same `courses` collection unless Firestore rules prevent it. The rules aren't in this repo. Don't add sensitive data to R2 without addressing this.
- Recording with a locked screen hasn't been tested on a real phone.
- The free plan's CPU limit hasn't been tested with very long lectures.

## Working in this repo

Don't commit or push unless asked, and use a branch and a pull request rather than committing to `main`. Merging and deploying are the owner's decisions, because they change the live site.
