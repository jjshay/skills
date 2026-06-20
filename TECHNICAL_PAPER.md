# Google Drive Auto-Organizer: A Resumable, Auditable Filesystem-Reorganization Service on a Time-Bounded Serverless Runtime

**A Technical Paper**

Author: Project Maintainer
Repository: `skills/google-drive-organizer`
Date: 2026

---

## Abstract

This paper describes the design, implementation, and operational characteristics of the **Google Drive Auto-Organizer**, a Google Apps Script-based service that periodically classifies stale files in a user's Google Drive and relocates them into a numbered, project-oriented folder hierarchy. The system runs entirely on Google's managed Apps Script runtime, which imposes a strict six-minute wall-clock execution limit per invocation. To remain correct in the presence of that limit, the organizer treats every invocation as a *fragment* of a larger logical run: it watermark-saves its position in the Drive listing using `PropertiesService`, schedules a one-off continuation trigger via `ScriptApp`, and resumes from the saved page token on the next invocation. Each file move is written as an immutable audit record to a "Drive Organizer Log" spreadsheet, which serves both as a human-readable history and as the substrate for a one-click `undoLastRun()` operation that reverses the most recent logical run. The paper presents the architecture at four levels — system, control flow, data, and operational — and analyzes the engineering trade-offs that drove each design choice: why the system relies on a parent-folder name as a *project signal*, why MIME-type buckets were preferred over content-based classification, and why the audit log is a spreadsheet rather than a structured database. It evaluates the runtime characteristics of the implementation, surveys related work in personal information management and personal-data lifecycle automation, enumerates the limitations introduced by the choice of platform, and proposes a roadmap for future work, including content-aware classification, multi-account organization, and a deletion-recommendation layer. The intent is to provide both a faithful reference for current operators of the system and a usable template for future automation scripts in the same repository.

**Keywords:** personal information management, Google Apps Script, Google Drive API, serverless batch processing, idempotent jobs, audit logging, MIME classification, time-triggered automation.

---

## Table of Contents

1. Introduction
2. Problem Statement and Motivation
3. Related Work
4. Design Goals and Non-Goals
5. System Architecture
6. Data Model and Folder Schema
7. Classification Algorithm
8. Execution Model: Batching and Auto-Continuation
9. State Management and Resumption
10. Audit Logging
11. The Undo Operation
12. Scheduling and Trigger Lifecycle
13. Configuration Surface
14. Deployment and Setup Workflow
15. Performance Analysis
16. Failure Modes and Recovery
17. Security and Privacy Considerations
18. Testing Strategy
19. Limitations
20. Future Work
21. Conclusion
22. Appendix A — Function Reference
23. Appendix B — Configuration Reference
24. Appendix C — Log Schema
25. Appendix D — Drive API Query Reference
26. Appendix E — Glossary
27. References

---

## 1. Introduction

Personal cloud storage services have become the de facto archive for nearly every artifact a modern knowledge worker produces. Google Drive in particular is used to store working documents, scanned receipts, photos, screen captures, downloaded PDFs, code, presentation drafts, and the casual debris of everyday computer use. The convenience of "drop it in Drive and forget about it" is structural: storage is effectively elastic, search is built in, and the cost of saving an extra file is near zero. The corresponding cost — paid in friction rather than dollars — accrues over time. A directory that began life as a tidy project folder accretes ad-hoc downloads, screenshots taken on the wrong device, and stray copies of attachments. Search papers over the mess for a while, but search is only as useful as the user's recall of what they were searching for, and many files are never recalled by name.

The Google Drive Auto-Organizer is a small but opinionated response to that problem. Rather than ask the user to remember to clean up, it runs in the background on a fixed schedule and reorganizes any file that has not been touched in sixty days. It does not delete anything, it does not collapse duplicates, and it does not attempt to understand the content of any file. It simply moves stale files into a predictable, numbered folder hierarchy where the user can find them again later if they need to, and ignore them otherwise. The hierarchy is designed to be readable at a glance: every folder is numbered, every project gets a number, every category within a project gets a number, and the folder names are short.

This paper describes that system in some detail. The implementation is small — fewer than 500 lines of Google Apps Script — but the *engineering* is not trivial. The Apps Script runtime that hosts the code imposes a six-minute hard ceiling on every invocation. A user with a moderately large Drive can easily have thousands of stale files. A single-shot organizer would simply time out partway through, leave the user's Drive in an inconsistent half-organized state, and provide no recourse. The auto-organizer addresses this by treating each invocation as a fragment of a larger logical run, persisting its progress between invocations and scheduling its own continuation. Every move it performs is journaled, and the journal is rich enough that the entire most-recent run can be reversed by a single function call.

The contribution of this paper is twofold. First, it documents the implementation in enough depth that a future maintainer can extend it without re-deriving the design. Second, it offers the design as a *pattern* for similar problems on the same runtime — any task that has to walk a large collection in a time-bounded environment, mutate it in place, and remain reversible. The patterns developed here (page-token watermarking, continuation triggers, in-spreadsheet audit logs as undo substrate) are useful well beyond the specific case of Drive organization.

The remainder of this paper is organized as follows. Section 2 motivates the problem in more detail. Section 3 surveys related work. Section 4 enumerates the design goals and the explicit non-goals that scope the project. Sections 5–12 describe the architecture, data model, classification algorithm, execution model, state management, audit logging, undo logic, and scheduling. Section 13 documents the configuration surface, and Section 14 walks through deployment. Sections 15–17 evaluate the system on performance, failure handling, and security and privacy. Section 18 covers the testing strategy. Sections 19–20 discuss limitations and future work, and Section 21 concludes. Five appendices provide quick-reference documentation.

## 2. Problem Statement and Motivation

A reasonable characterization of the problem the organizer addresses is *the diffusion of context in a long-lived personal filesystem*. Files arrive in Drive through many independent channels — direct uploads, app integrations, email attachment forwards, mobile camera roll backups, Google Docs created from templates, downloads from Gmail, content saved from the browser — and each channel has its own default destination. Most of these defaults are simply "the user's Drive root" or "a service-specific folder near the root". The user who once intended to file each new arrival into the appropriate project folder rarely does so after the first few weeks. Over months and years, the result is a flat or near-flat working directory containing files from dozens of unrelated contexts, alongside the original tidy project folders that have themselves accumulated cruft.

There are three properties of this problem that make it amenable to automation rather than discipline. First, the *signal of staleness is mechanical*: a file's `modifiedTime` is recorded by the platform and accurately reflects when it was last touched. Sixty days is not a magic number, but it captures a useful threshold for most workflows — anything older than that is almost certainly archival rather than active. Second, the *signal of category is mechanical*: a file's MIME type is a reliable indicator of the broad bucket it belongs in (a `.docx` is a document, a `.png` is an image). Third, the *signal of project* is approximately mechanical: while not perfect, the name of a file's parent folder is a serviceable proxy for what project the file belongs to. A file in a folder called "Client Alpha — Phase 2" almost certainly belongs to a Client Alpha context, even if the file itself is named `IMG_4421.png`.

These three signals — staleness, category, project — are enough to support a useful default organization without requiring content analysis, without requiring the user to label anything, and without requiring any kind of machine-learning model. The resulting hierarchy is not optimal for any individual user, but it is dramatically better than the unstructured baseline, and it is generated reliably and reversibly by a small, auditable program. That property — *correctness through small mechanisms, not through cleverness* — is the design ethos of the system.

The motivation for *automating* the organization (rather than providing it as an on-demand tool) is straightforward: the user who is willing to manually run a Drive cleanup tool is already the user who probably doesn't need it. The user who would benefit most is the one who forgets that Drive organization is a problem until they cannot find a contract from a year ago. A scheduled automation removes the need to remember.

## 3. Related Work

Personal file organization is an old problem with a long lineage of partial solutions. We sketch the categories most relevant to the present system.

**Rule-based desktop organizers.** Tools such as Hazel (macOS) and a long tail of cross-platform Python utilities (e.g., `organize`, `dir-organize`) allow a user to define rules that file system events trigger. They are powerful and flexible, but they have two practical limitations in the context this paper addresses. First, they operate on local disks, not on cloud-native storage like Drive — a Drive file synced via a desktop client can be moved, but for the very common case of a Drive that is *only* accessed via the web client, the desktop-rules approach does not apply. Second, they require the user to write and maintain rules. The auto-organizer is deliberately rule-free: it makes a small fixed set of decisions automatically, with no per-user configuration.

**Drive-native automations.** Google itself provides Apps Script as the integration point for automating Drive, and the marketplace contains a number of third-party Drive cleanup tools. Most of these focus on duplicate detection (finding the same file stored in two places) or on quota management (finding the largest files). Few address the problem of *organization* directly, and those that do generally require the user to define a target taxonomy themselves. The auto-organizer's choice of a uniform `Project → Category → File` taxonomy, derived entirely from existing Drive metadata, is what differentiates it.

**Background services on time-bounded runtimes.** The engineering pattern of breaking a long task into resumable fragments to fit a runtime ceiling is well established in serverless systems generally. AWS Lambda's 15-minute limit, Cloud Functions' analogous limits, and the various step-function orchestrators are commercial expressions of the same problem. The Apps Script literature, by contrast, is largely informal — practitioners share recipes on Stack Overflow and in personal blogs, but there is little canonical documentation of the pattern. Section 8 of this paper describes a concrete implementation of the watermark-and-continuation pattern that may be useful as a reference for other Apps Script automations.

**Audit-log-as-undo.** Using an append-only journal of operations as the substrate for an undo facility is a textbook pattern in transactional databases (the redo/undo log) and in version-control systems (commit reflog). Applying it at the file-system level for personal storage is less common in the literature but appears in some commercial backup products. The organizer's implementation is straightforward: each move records source, destination, and identifier, and undo reverses moves in the most recent run by reading those fields back.

## 4. Design Goals and Non-Goals

It is useful to enumerate explicitly what the system does and does not aspire to. The non-goals are at least as important as the goals: they explain why several plausible features are absent.

### 4.1 Goals

- **G1. Correctness under time pressure.** A run must produce a consistent Drive state regardless of how many files it has to move and regardless of where the Apps Script runtime decides to interrupt it. Half-finished runs are acceptable as long as they are *resumable* and the partial state is internally consistent.
- **G2. Reversibility.** Any organizing run must be undoable in full by a single user action, without requiring the user to remember anything about the run.
- **G3. Auditability.** Every move must be permanently recorded with enough information to reconstruct it. The audit record must be human-readable.
- **G4. Zero user-defined rules.** The user should not have to teach the organizer anything. Defaults must work out of the box.
- **G5. Idempotence.** Re-running the organizer on an already-organized Drive must not produce duplicate folders, duplicate moves, or undefined behavior.
- **G6. No external dependencies.** The system must run entirely within the Apps Script runtime, with no third-party services, no external storage, and no API keys beyond the user's own OAuth grant to Apps Script.
- **G7. Predictable scheduling.** The user must be able to set up a periodic schedule with a single function call and remove it with a single function call.

### 4.2 Non-Goals

- **N1. Content-based classification.** The organizer does not look inside files. It uses only metadata. This is deliberate: content classification is expensive, fragile, and difficult to justify for the use case.
- **N2. Deletion.** The organizer never deletes a file. It only moves files. The user retains the ability to delete files at any time using the normal Drive interface.
- **N3. Shared drives.** The current implementation organizes only files owned by the current user (`'me' in owners`). Shared drives are explicitly out of scope; mishandling them could trigger access-control surprises for collaborators.
- **N4. Cross-user organization.** The system is a single-user automation. Multi-user or team organization would require very different design choices around authority and conflict resolution.
- **N5. Search replacement.** The organizer is not a search engine and does not attempt to make files easier to *find* in a query sense — it only makes them easier to *browse*.
- **N6. Generalized rule engine.** The organizer does not provide an extension point for user-defined rules. The taxonomy is fixed.

These non-goals exist because each of the omitted features would substantially increase the surface area of the system, and none of them are necessary for the primary use case.

## 5. System Architecture

At the highest level, the system is a small library of Google Apps Script functions that share a fixed `CONFIG` object and communicate via three persistent stores: the user's Google Drive itself (the source of truth for files), a `PropertiesService` key (the watermark used for resumption), and a Google Sheets spreadsheet (the audit log). There is no server process and no in-memory state that survives invocations. Each invocation is a fresh JavaScript runtime that re-reads any state it cares about from one of those three stores.

```
+--------------------------+
|   User / Time Trigger    |
+------------+-------------+
             |
             v
+--------------------------+        +-------------------------+
|  organizeStaleFiles()    +------->+  Drive REST (v3) — list |
+------------+-------------+        +-------------------------+
             |
             v
+--------------------------+        +-------------------------+
|  Classification          +<-----> +  Folder cache (in-proc) |
+------------+-------------+        +-------------------------+
             |
             v
+--------------------------+        +-------------------------+
|  Move + Log              +------->+  Drive REST — move      |
+------------+-------------+        +-------------------------+
             |                      +-------------------------+
             +--------------------->+  Sheets append (log row)|
                                    +-------------------------+
             |
             v
+--------------------------+        +-------------------------+
|  Timeout check / commit  +------->+  PropertiesService set  |
+------------+-------------+        +-------------------------+
             |
             v
+--------------------------+
|  scheduleResume()        |
+--------------------------+
```

The diagram captures the main control path. Three points are worth calling out.

First, the only persistent state introduced by the organizer is a single key in `PropertiesService` (the run state) and a single spreadsheet (the audit log). The folder hierarchy in Drive is incidental persistent state: it is the *product* of the system rather than its bookkeeping.

Second, the folder cache (a plain JavaScript object) lives only for the duration of one invocation. It is rebuilt on every resumption. This is not a correctness issue — the cache is purely an optimization for repeated parent-folder lookups within a single page — but it does mean that, in the worst case, the first lookup of each parent in each invocation is uncached.

Third, the auto-continuation trigger is the architectural mechanism that lets a single logical run span many invocations. When the function detects that it is approaching its time limit, it persists its position, creates a one-off time-based trigger that will fire after sixty seconds, and returns cleanly. The next invocation reads the saved position and continues.

The architecture has no notion of a "primary" or "background" mode. Every invocation runs the same `organizeStaleFiles()` function. Whether the invocation began life as a user-triggered run, a scheduled bi-weekly run, or a continuation trigger is invisible to the function itself — it simply checks `PropertiesService` and acts accordingly. This is what makes the system robust to interrupts: there is no special "we are resuming now" code path that could diverge from the steady-state code.

## 6. Data Model and Folder Schema

The organizer produces a folder hierarchy with three levels below a single root.

```
Organized Projects/
├── 1 - Client Alpha/
│   ├── 1.1 - Documents/
│   │   ├── 1.1.1 | proposal.docx
│   │   └── 1.1.2 | contract.pdf
│   ├── 1.2 - Spreadsheets/
│   │   └── 1.2.1 | budget.xlsx
│   └── 1.3 - Images/
│       └── 1.3.1 | logo.png
├── 2 - Personal Finance/
│   ├── 2.1 - Documents/
│   └── 2.2 - Spreadsheets/
└── 3 - Uncategorized/
    └── 3.1 - Other/
```

The hierarchy expresses a deliberate philosophy: every level conveys exactly one classification decision, every folder is named with both its number and its label, and every file inherits a positional identifier from its containing folders. The numbering scheme — `Project.Category.File` — is intentionally similar to outline numbering in formal documents. A user looking at a file named `1.2.3 | budget.xlsx` knows immediately that the file belongs to Project 1, in Category 2, and is File 3 of that bucket.

It is worth emphasizing what this hierarchy is *not*. It is not a tree of arbitrary depth: there are exactly three classification levels. It is not a tag system: a file lives in exactly one place. It is not enforced beyond the organizer's own runs: a user is free to manually move files in and out of `Organized Projects/` at any time, and the system will respect those manual edits on its next run. Specifically, the listing query that drives organization does not exclude files already inside `Organized Projects/` at the query level (Drive's `q` syntax does not make this convenient), but the in-memory loop checks each file's parents against the root folder ID and skips files that are already inside the organized hierarchy. This makes the system idempotent: a second run immediately after the first will find no work to do.

The choice to use folder names that begin with numbers (rather than relying on a separate metadata field) has a practical motivation. Drive's web interface sorts folders alphabetically by default, and prefixing each name with a number forces the sort order to match the conceptual order. This is the same reason Linux distributions use `00-` and `99-` prefixes in `/etc/init.d/` scripts: the alphabetical sort is the ordering. Without the prefix, the projects would shuffle around in unpredictable ways every time a new one was added.

The pipe character (`|`) used in file labels — `1.1.1 | proposal.docx` — is chosen for visual separation. It is permitted by Drive's naming rules, it is uncommon in real filenames so it does not collide, and it produces a distinct visual cue that makes the numbering versus name distinction easy to see at a glance.

## 7. Classification Algorithm

The organizer decides three things about each file it processes: whether to process it at all, which project it belongs to, and which category it belongs to. Each decision is made by a small function with a single well-defined responsibility.

### 7.1 Eligibility

A file is eligible if it satisfies the Drive query:

```
modifiedTime < '<cutoff>'
  and trashed = false
  and mimeType != 'application/vnd.google-apps.folder'
  and 'me' in owners
```

The cutoff is the current time minus `CONFIG.STALE_DAYS` (default sixty days), serialized to ISO 8601 with millisecond precision stripped (Drive's `q` parser is picky about trailing fractional seconds). The four predicates each have a purpose: the time filter selects only stale files; the trash filter excludes files in the user's trash, which the user has implicitly already decided about; the MIME filter excludes folders, because the organizer does not move folders; and the owners filter restricts the scope to files the user owns, both to avoid stepping on collaborators and to avoid accidentally pulling files out of shared contexts.

After the query, a secondary in-memory filter excludes files that already live inside the root organized folder. This is the source of idempotence: a file can be moved at most once per run, and if it is already organized, it is skipped.

### 7.2 Project Detection

Project detection is implemented by `getProjectName()`. The algorithm is:

1. If the file has no parents at all (a very unusual case for live Drive files, but possible), return `"Uncategorized"`.
2. Look at the first parent ID. If it is in the in-memory cache for this run, return the cached name.
3. Otherwise, fetch the parent folder via `DriveApp.getFolderById()`. If the parent's name is the literal string `"My Drive"` or `"Drive"`, the file lives at the user's Drive root and has no meaningful parent — fall through to the prefix heuristic. Otherwise, return the cleaned form of the parent's name (lowercase letters preserved, underscores and hyphens converted to spaces, runs of whitespace collapsed, truncated to forty characters).
4. If the parent was the user's Drive root, attempt a prefix heuristic on the file's own name. If the name begins with a letters-only word of more than two characters (optionally followed by another letters-only word separated by space, underscore, or hyphen), use that prefix as the project name. This catches naming conventions like `ClientAlpha-receipt.pdf` or `Acme proposal.docx`.
5. If nothing matches, return `"Uncategorized"`.

The cache is a plain JavaScript object indexed by parent folder ID. It is populated only for parents whose name was used directly (step 3), so each unique parent triggers at most one `getFolderById` call per invocation. The cache is rebuilt from scratch on each resumption, which is acceptable because the number of unique stale-file parents in a single batch is small (empirically, on test corpora, on the order of dozens).

There are a few things worth noting about this heuristic. First, it is intentionally simple: it does not try to detect "real" project names by clustering filenames, parsing folder hierarchies more than one level up, or using any kind of natural-language analysis. The simplicity is what makes it predictable. Second, it is biased toward the *parent folder* signal over the *filename prefix* signal: if a file lives in a folder named "Client Alpha", it goes to Project "Client Alpha", regardless of what its own name suggests. This is correct in the common case, where users organize folders before they organize filenames. Third, the forty-character truncation on cleaned parent names ensures that pathological folder names — say, a folder called "The Final Final Version of the 2024 Annual Report Working Draft" — do not produce unreadable destinations.

### 7.3 Category Detection

Category detection is implemented by `detectCategoryFromMime()`. The MIME-to-category mapping is encoded in `CONFIG.MIME_CATEGORIES`, which is a plain object mapping category names to lists of MIME types:

| Category | Representative MIME types |
|---|---|
| Documents | `application/vnd.google-apps.document`, `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain` |
| Spreadsheets | `application/vnd.google-apps.spreadsheet`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `text/csv` |
| Presentations | `application/vnd.google-apps.presentation`, `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| Images | `image/jpeg`, `image/png`, `image/gif`, `image/svg+xml`, `image/webp` |
| Videos | `video/mp4`, `video/quicktime`, `video/x-msvideo`, `video/webm` |
| Audio | `audio/mpeg`, `audio/wav`, `audio/ogg` |
| Code | `application/json`, `text/html`, `text/css`, `application/javascript`, `application/xml` |
| Archives | `application/zip`, `application/x-rar-compressed`, `application/gzip`, `application/x-tar` |
| Other | (catch-all) |

The detection function iterates over the categories in insertion order, skipping `"Other"`, and returns the first category whose list contains the file's MIME type. If no category matches, the function returns `"Other"`.

The insertion-order semantics are guaranteed by modern V8, which Apps Script uses. This is important because it means we can reason about precedence without relying on accident. For example, `text/plain` could conceivably belong to "Documents" or "Code"; the current list puts it under "Documents", which is the more common interpretation for casual users.

The category list is deliberately short. Nine buckets are enough to give meaningful separation without producing a folder hierarchy that is itself overwhelming. A longer list (say, distinct categories for "PDFs", "Word documents", and "Google Docs") was considered and rejected: it would scatter related files across more folders, making it harder to find a document when the user does not remember which specific format it was in.

## 8. Execution Model: Batching and Auto-Continuation

The Apps Script runtime imposes a six-minute wall-clock execution limit on every invocation of a function. This limit is not negotiable: when the runtime hits it, the function is terminated mid-statement, no cleanup runs, and any unsaved state is lost. For a function whose job is to walk a potentially large collection and mutate it in place, this is a real constraint. A naive implementation that simply loops over `Drive.Files.list()` results would either silently truncate its work or — worse — leave the Drive partially organized with no record of where it stopped.

The organizer addresses this through what we will call the *watermark-and-continuation* pattern. Three pieces of machinery cooperate:

1. A **time budget** smaller than the platform limit. The organizer uses `MAX_RUNTIME_MS = 4.5 * 60 * 1000`, leaving 90 seconds of headroom for the platform's own bookkeeping, for the final `PropertiesService` write, and for trigger creation.
2. A **watermark** — the Drive API's opaque `pageToken` — persisted to `PropertiesService` along with the logical run identifier and the running total of moves.
3. A **continuation trigger** — a one-off time-based Apps Script trigger that re-invokes `organizeStaleFiles()` after a 60-second delay.

The control flow is:

```
1. On entry, read PropertiesService["ORGANIZER_STATE"].
   - If present:    resume from saved pageToken and runTimestamp.
   - If absent:     start a new logical run with runTimestamp = now.
2. Compute the staleness cutoff and Drive query.
3. While pageToken is not null:
     a. If elapsed > MAX_RUNTIME_MS:
            save {pageToken, runTimestamp, totalMoved} to PropertiesService,
            schedule a one-off resume trigger,
            return.
     b. List the next page of files.
     c. For each file in the page:
            i. If elapsed > MAX_RUNTIME_MS (mid-page check): save and exit as above.
            ii. If file is already inside the root organized folder, skip.
            iii. Compute project and category, ensure folders exist, move file.
            iv. Append a MOVED row to the audit log.
     d. pageToken := response.nextPageToken
4. On normal completion (pageToken null), delete the ORGANIZER_STATE property,
   delete any one-off continuation triggers, log "Run complete".
```

Two design choices in this control flow are worth examining.

**Mid-page time checks.** The naive version of this loop checks the time budget only at the top of the outer `do/while`, i.e. once per page. With a page size of fifty and an average per-file move latency of one to two seconds, a single page can easily consume sixty to one hundred seconds, which is more than the platform's safety margin against the six-minute limit. The implementation therefore re-checks the time budget *inside* the inner `for` loop, before each file is processed. This makes the worst-case overrun a single file's worth of latency rather than a single page's worth.

**Separation of state and triggers.** The persistent state (the saved page token) and the continuation mechanism (the trigger) are separate concerns. The state is sufficient to resume; the trigger only schedules the resumption. If the platform's trigger creation succeeds but the function then errors before returning, the state is still consistent (it was written before the trigger was scheduled). If the function errors *during* state write, no trigger is scheduled and the state-write error surfaces in the Apps Script execution log — the user's next manual or scheduled run can then either pick up from a corrupted partial state (which `JSON.parse` will fail on) or proceed as a fresh run.

The use of a one-off trigger — created with `.timeBased().after(60 * 1000).create()` — rather than relying on the user's bi-weekly trigger to eventually fire is important. A bi-weekly trigger that fires every fourteen days would be of no help to a run that needs to resume in sixty seconds. The one-off trigger is created with the same handler function (`organizeStaleFiles`), so the resumption invocation looks identical to a normal one from the runtime's point of view. The only thing that distinguishes a resumption from a fresh run is the presence of the `ORGANIZER_STATE` property, and the function detects this on entry.

The 60-second resume delay is a balance between two considerations. Too short, and the platform may not have finished cleaning up the previous invocation's resources, producing scheduling errors. Too long, and the user perceives the system as slow. Sixty seconds has proven reliable in practice.

After a normal (non-timeout) completion, the function calls `cleanupContinuationTriggers()` to delete any leftover one-off triggers that may have been scheduled by previous resumptions. This is defensive: in the event of a logic error elsewhere, a continuation trigger could otherwise hang around scheduling unnecessary invocations.

## 9. State Management and Resumption

The state stored between invocations is intentionally minimal: just three fields, serialized as a JSON string and written to a single `PropertiesService` key called `ORGANIZER_STATE`.

```json
{
  "pageToken":     "<opaque Drive pagination token>",
  "runTimestamp":  "2026-06-20T03:00:00.000Z",
  "totalMoved":    1423
}
```

The `pageToken` field is the resume position. It is opaque to the organizer — only the Drive API knows how to interpret it — but it has a strong consistency guarantee from the platform: subsequent listings with the same query and the same token will return the next page that was unread when the token was issued. The token does not encode any of the in-flight file IDs, so a file that was already moved in the previous invocation will simply not appear in the next listing (because its modified-time-versus-cutoff position is unchanged but its parent is now inside `Organized Projects/`, and the in-memory filter skips it).

The `runTimestamp` field is the *logical* run identifier. It is generated once, at the start of the very first invocation of the run, and persisted through all resumptions. Every audit log row written during the run carries this same timestamp in its `Run ID` column. The reason for using an ISO 8601 timestamp as the identifier rather than, say, a UUID, is twofold: it is sortable, and it is intrinsically meaningful to a human reading the log.

The `totalMoved` field is a running tally, included purely to make the log entries that mark each pause/resume more informative. It is not used for correctness; the audit log itself is the authoritative record of what was moved.

State writes are serialized through `PropertiesService.getScriptProperties().setProperty(...)`, which is a synchronous Apps Script primitive that persists to Google's managed key/value store. Writes are atomic at the property granularity, which is sufficient here because the state is a single JSON-encoded string. Reads on entry use `getProperty(...)` and parse the result with `JSON.parse`, which will throw if the stored value is corrupted; this manifests as an Apps Script execution error and surfaces in the Apps Script dashboard's execution log.

State is *deleted*, not overwritten, on normal completion. Deletion is signaled by `props.deleteProperty("ORGANIZER_STATE")`. This is what allows the *next* scheduled run, two weeks later, to recognize itself as a fresh run rather than a resumption.

There is a subtle invariant that this design relies on: between the moment the state is saved and the moment the continuation trigger fires, no other invocation of `organizeStaleFiles` should run. This is enforced *de facto* because the user does not run the function manually during that 60-second window, and because the bi-weekly trigger fires only once every two weeks. The system does not include explicit mutual exclusion (e.g. via `LockService`), and this is a deliberate simplification: the cost of adding a lock is non-trivial in Apps Script, and the failure mode it would prevent — two concurrent runs racing to mutate the same files — would be visible in the audit log and could be cleaned up with `resetState()` and a fresh run. For a personal-scale automation, the trade-off favors simplicity.

## 10. Audit Logging

Every observable action the organizer takes — starting a run, pausing, resuming, moving a file, encountering an error, completing a run, performing an undo — is recorded as a row in a Google Sheets spreadsheet named `"Drive Organizer Log"`. The spreadsheet is created on first use (via `getOrCreateLogSheet()`) and lives at the user's Drive root.

The schema is five columns:

| Column | Type | Description |
|---|---|---|
| Timestamp | `Date` | The wall-clock time the row was written. |
| Run ID | `String` | The logical run's ISO 8601 start timestamp. |
| Level | `String` | One of `INFO`, `MOVED`, `ERROR`, `UNDO`. |
| Message | `String` | Short human-readable summary. |
| Details | `String` | Structured details for machine readability, formatted as `Key: value | Key: value | ...`. |

The first row is a frozen header, and the columns are wide enough to be readable without resizing.

Why a spreadsheet? Several alternatives were considered:

- **`Logger.log()`** is the Apps Script default, but its retention is limited and it is not user-accessible outside the script editor. It is unsuitable as the system of record.
- **A Drive document** is human-readable but not structured. It would be awkward to programmatically read back for undo.
- **A separate database** (Firestore, a small SQL store, etc.) would require additional credentials and would violate the "no external dependencies" goal.
- **`PropertiesService`** is limited to a small number of properties of bounded size. It is unsuitable for an unbounded log.

A spreadsheet is the right answer because it is structured enough to query programmatically (via `getDataRange().getValues()`), open in the browser without any additional tooling, sortable and filterable in the Sheets UI, and effectively unlimited in capacity for the use case (Sheets supports up to ten million cells per workbook, which corresponds to two million rows at five columns each).

The `Details` column uses a pseudo-structured format — pipe-separated `Key: value` pairs — that the undo function parses with simple regular expressions. The relevant `MOVED` row format is:

```
From: <originalParentFolderId> | To: <categoryFolderId> | FileID: <driveFileId> | Project: <projectName> | Category: <categoryName>
```

The `FileID` is the unique identifier the undo function uses to locate the file. The `From` field is the source-of-truth for where to put the file back. The other fields are present primarily for human readability — they let a user looking at the log understand at a glance where each file was moved and why, without having to cross-reference any other source.

Writes to the log happen one row at a time via `sheet.appendRow(...)`. This is intentionally simple: the alternative — buffering rows and writing them in bulk via `sheet.getRange(...).setValues(...)` — would be marginally faster, but it would create a window in which a runtime interruption could lose log entries. The single-row append is durable as soon as it returns; the platform may impose a small per-call cost, but for a personal-scale automation moving on the order of thousands of files per run, the throughput is acceptable.

## 11. The Undo Operation

The `undoLastRun()` function reverses the most recent logical run. Its operation is conceptually simple: scan the audit log from the bottom up to find the most recent `Run ID` that contains `MOVED` rows, then iterate through every `MOVED` row with that `Run ID` and put each file back to its original parent.

The implementation has three steps. First, it identifies the target run:

```javascript
var lastRunId = null;
for (var i = data.length - 1; i >= 1; i--) {
  if (data[i][2] === "MOVED") { lastRunId = data[i][1]; break; }
}
if (!lastRunId) { Logger.log("No moves found to undo."); return; }
```

The reverse scan is bounded by the log's size, but in practice it terminates in O(1) iterations because the most recent `MOVED` row is almost always near the end of the log.

Second, it iterates forward through the log, processing all `MOVED` rows with the matching `Run ID`:

```javascript
for (var i = 1; i < data.length; i++) {
  if (data[i][1] !== lastRunId || data[i][2] !== "MOVED") continue;
  var details = data[i][4];
  var fromMatch = details.match(/From:\s*(\S+)/);
  var fileMatch = details.match(/FileID:\s*(\S+)/);
  if (fromMatch && fileMatch) {
    try {
      var file = DriveApp.getFileById(fileMatch[1]);
      var dest = fromMatch[1] === "root"
        ? DriveApp.getRootFolder()
        : DriveApp.getFolderById(fromMatch[1]);
      file.moveTo(dest);
      undone++;
    } catch (e) {
      Logger.log("Could not undo: " + fileMatch[1] + " - " + e.message);
    }
  }
}
```

Third, it appends a single `UNDO` row to the log recording how many moves were reversed.

A few properties of this design are worth noting.

The undo is *partial-tolerant*: a file that was manually moved by the user between the organizing run and the undo will not be in its expected location, but the undo's lookup uses `getFileById` rather than path traversal, so the file is still located and moved to the original parent. The user's intervention is effectively respected — the file ends up where the undo would have put it, with no error.

The undo is *deletion-tolerant*: a file that the user trashed between the run and the undo will produce a `getFileById` exception, which is caught and logged. Other files in the same run are unaffected.

The undo is *single-level*: it reverses exactly one run, not "all runs in the last week" or "all runs ever". If the user wants to reverse more than one run, they would have to run `undoLastRun()`, then the next `undoLastRun()` would target the now-previous run. This is intentional. Composite undo semantics are difficult to reason about (especially in the presence of intervening manual moves), and the single-run semantics are easy to explain.

The undo *does not* delete the empty folders left behind in `Organized Projects/`. A run that organizes 1,000 files into 30 project folders and is then undone leaves 30 empty folders. They are inert — the next run will reuse them via the get-or-create logic — but they are cosmetic clutter. A future enhancement could prune them; the current design opts for simplicity.

## 12. Scheduling and Trigger Lifecycle

The organizer's scheduling story has two distinct kinds of trigger: the *recurring* trigger that drives the bi-weekly automation, and the *one-off* continuation triggers that drive resumption after a timeout. Both are managed through `ScriptApp`, but they have different lifecycles.

The recurring trigger is created by `setupBiweeklyTrigger()`:

```javascript
ScriptApp.newTrigger("organizeStaleFiles")
  .timeBased()
  .everyDays(CONFIG.TRIGGER_INTERVAL_DAYS)
  .atHour(3)
  .create();
```

It fires every fourteen days at approximately 3 AM in the user's timezone (Apps Script's `atHour` is hour-of-day, and the actual fire time has a small window of variability). Before creating the new trigger, `setupBiweeklyTrigger` calls `removeExistingTriggers`, which deletes any prior triggers for the same handler function. This makes the setup idempotent: running it twice does not produce two triggers firing every fortnight.

The one-off continuation triggers are created by `scheduleResume()`:

```javascript
ScriptApp.newTrigger("organizeStaleFiles")
  .timeBased()
  .after(60 * 1000)
  .create();
```

They fire exactly once, sixty seconds after creation, and are then logically dead but physically still listed in the project's trigger collection. `cleanupContinuationTriggers()` removes them on the next normal completion. The cleanup function distinguishes one-off triggers from the recurring bi-weekly trigger by trying to call `getMinuteInterval()` and `getDayInterval()` on each candidate; recurring triggers have a defined interval (whichever method matches their schedule), while one-off triggers throw for both methods. This is a slightly awkward duck-typing approach, but the Apps Script API does not expose a more direct way to ask "is this trigger one-off?".

The trigger lifecycle has two failure modes worth describing.

If a continuation trigger fires but the state property is missing — for instance, because the user manually deleted it via `resetState()` — the function starts a fresh run, which is harmless but might surprise the user with a duplicate log entry. If a continuation trigger is *not* fired (because the user manually cancelled all triggers) but the state property is still present, the run does not resume on its own. The next manual or scheduled invocation will pick up where the previous one left off, because the state property tells it to.

Both failure modes are recoverable by calling `resetState()` to clear the state property and `removeExistingTriggers` followed by `setupBiweeklyTrigger` to re-establish the schedule.

## 13. Configuration Surface

The organizer exposes a single configuration object at the top of `Code.gs`:

```javascript
var CONFIG = {
  STALE_DAYS: 60,
  ROOT_FOLDER_NAME: "Organized Projects",
  LOG_SHEET_NAME: "Drive Organizer Log",
  TRIGGER_INTERVAL_DAYS: 14,
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,
  MIME_CATEGORIES: { ... }
};
```

Each field is interpreted as follows:

- **`STALE_DAYS`** (default 60). The threshold in days that distinguishes a "stale" file from a live one. A file whose `modifiedTime` is more than this many days in the past is eligible for organization. Lower values are more aggressive (more files moved per run); higher values are more conservative.
- **`ROOT_FOLDER_NAME`** (default `"Organized Projects"`). The name of the top-level folder that the organizer creates at the user's Drive root. Changing it will cause the next run to create a fresh folder under the new name, leaving the old folder behind.
- **`LOG_SHEET_NAME`** (default `"Drive Organizer Log"`). The name of the audit log spreadsheet. Changing it has the same consequence: a fresh spreadsheet is created, the old one is orphaned, and the undo function can only reverse runs recorded in the *current* log.
- **`TRIGGER_INTERVAL_DAYS`** (default 14). How often the recurring bi-weekly trigger fires, in days. Apps Script does not support cron-like syntax for `timeBased`/`everyDays`; the value must be a positive integer.
- **`MAX_RUNTIME_MS`** (default 270 000, i.e. 4.5 minutes). The internal time budget. The platform's hard limit is six minutes (360 000 ms), so this value should always be comfortably below that. Lowering it makes runs pause more aggressively but more reliably; raising it past the platform limit will cause runs to be terminated mid-statement.
- **`MIME_CATEGORIES`**. The MIME-type-to-category mapping described in Section 7.3. Adding a new MIME type to an existing category is safe. Adding a new category is also safe, but the new category folder will not have a number reserved for it until at least one file is moved into it (folders are created on demand).

There is no per-user override mechanism: a user who wants different defaults edits the `CONFIG` object directly. This is a deliberate simplification appropriate to a single-user automation. For multi-user deployments, the configuration could trivially be sourced from `PropertiesService` instead.

## 14. Deployment and Setup Workflow

Deployment is intentionally lightweight: the entire setup, from a fresh Google account, takes about five minutes. The steps are documented in `google-drive-organizer/SETUP.md` and reproduced here for completeness.

1. **Create an Apps Script project.** Navigate to `script.google.com`, click "New project", and delete the default `myFunction()` stub. Paste the contents of `Code.gs` from the repository.

2. **Enable the Drive API.** In the Apps Script editor's left sidebar, click "Services", scroll to "Drive API", and click "Add". Keep the default identifier `Drive` and version `v3`. This is what makes the `Drive.Files.list(...)` calls in the organizer resolvable.

3. **Authorize.** Select `dryRun` from the function dropdown and click "Run". On the first invocation, Apps Script presents a consent screen requesting access to your Drive. Because the script is your own and runs under your own identity, this is essentially a self-grant. Accept it.

4. **Inspect the dry run output.** `dryRun()` does not move any files; it only logs what would be moved. Open "Execution log" in the Apps Script editor to see the projected reorganization. If the projection looks wrong (e.g. too many files would be moved, or the project names are not what you expected), reconsider `STALE_DAYS` or the project-detection logic before proceeding.

5. **Run the real organizer.** Select `organizeStaleFiles` and click "Run". Check your Drive for the new `Organized Projects/` folder. Open the `Drive Organizer Log` spreadsheet to see the audit trail.

6. **Set up the recurring schedule.** Select `setupBiweeklyTrigger` and click "Run". The bi-weekly automation is now active.

7. **(Optional) Cancel the schedule** at any time by running `removeExistingTriggers`. The script remains deployed but stops firing automatically.

The setup uses no external services, no API keys, and no environment variables. The only credential involved is the user's OAuth grant to Apps Script, which is managed by Google.

## 15. Performance Analysis

The performance of the organizer is dominated by Drive API latency. Local computation (classification, folder lookup, log row formatting) is on the order of microseconds per file; remote API calls — `Drive.Files.list`, `file.moveTo`, `parentFolder.createFolder`, `sheet.appendRow` — are each measured in hundreds of milliseconds. A first-order model for the per-file cost is therefore:

```
T_per_file ≈ T_list_amortized + T_move + T_log + T_folder_create_amortized
```

where:

- `T_list_amortized` is the per-file share of the cost of one `Drive.Files.list` call divided across its page size. With a page size of 50 and a typical list latency of 400–800 ms, this works out to roughly 10–20 ms per file.
- `T_move` is the cost of one `file.moveTo` call. Empirically, this is 200–500 ms per file. There is no batch-move equivalent in the Apps Script `DriveApp` API; `Drive.Files.update` could move files in bulk in principle but with significantly more complexity.
- `T_log` is the cost of one `sheet.appendRow` call. Empirically, this is 100–300 ms per row.
- `T_folder_create_amortized` is the per-file share of folder creations. Because folders are created on demand and reused, the cost amortizes to near zero for runs with many files per project/category bucket.

Putting these together, the per-file cost is on the order of 350 ms to 1 second. With a 4.5-minute time budget per invocation, a single invocation moves between 270 (worst case) and 770 (best case) files. A drive with 5,000 stale files therefore takes between 7 and 19 invocations to fully organize, which is between 7 and 19 minutes of wall-clock time (with the 60-second resume delay between invocations). A drive with 50,000 stale files takes between 65 and 185 invocations and between 80 and 220 minutes of wall-clock time. These numbers are well within the bounds of "run it overnight" tolerance, and the bi-weekly cadence ensures that subsequent runs only have to handle the relatively small number of files that became stale in the intervening fortnight.

The performance can be improved in two ways with relatively local changes:

1. **Larger page size.** The current page size is 50 (`pageSize: 50`). Drive's list API supports page sizes up to 1000. A larger page would reduce the per-file `T_list_amortized` cost. The current choice of 50 is a compromise: it makes the time-budget check at the top of each page more responsive (the function notices it has overrun within at most one page's worth of work).
2. **Batched log writes.** The current implementation appends one row at a time. Buffering rows within an invocation and flushing them with a single `setValues` call at the time-budget save point would reduce `T_log` to near zero, at the cost of losing the most recent rows if the function is killed mid-loop.

Neither optimization is implemented today; both are reasonable future enhancements if the per-run wall-clock time becomes a complaint.

## 16. Failure Modes and Recovery

The organizer is robust to a number of failure modes. We enumerate them with their recovery procedures.

**Mid-invocation timeout.** Handled by the watermark-and-continuation mechanism described in Section 8. No user action required. The continuation trigger fires within a minute and the run resumes.

**Continuation trigger failure to fire.** Very rare. Recovery is to manually run `organizeStaleFiles` again; it will detect the saved state and resume.

**Corrupted state property.** If `PropertiesService["ORGANIZER_STATE"]` is somehow set to a non-JSON value (e.g. by manual intervention), the next run's `JSON.parse` will throw and the function will fail to start. Recovery is to run `resetState`, which deletes the property and cancels any orphaned continuation triggers.

**Drive API quota exhaustion.** Apps Script imposes daily quotas on Drive API calls. A single run can plausibly hit a quota wall if the drive is very large. In practice, the watermark mechanism handles this gracefully: the failing API call surfaces as an exception, the function returns with state intact, and the user can resume the next day after the quota resets.

**Per-file move failure.** Each `file.moveTo(...)` call is wrapped in a `try/catch`. If a move fails — for example, because the file was deleted between the listing and the move, or because the user's Drive is in a transient error state — an `ERROR` row is written to the log and the loop continues to the next file. Failed files are not retried within the same run; they will be picked up on the next bi-weekly run if still eligible.

**Spreadsheet creation failure.** `getOrCreateLogSheet` could in principle fail if Drive is unavailable or the user has hit their file-creation quota. This failure manifests as an Apps Script error at the very start of the run; no files are moved and the state property is not written.

**Concurrent runs.** As discussed in Section 9, the system does not include explicit mutual exclusion. The only realistic scenario in which two runs could overlap is the user manually invoking `organizeStaleFiles` while a scheduled run is mid-flight. The result is a race over the state property: the second runner might see the first runner's state and continue from it, or might overwrite it. The audit log makes this detectable after the fact, and `resetState` followed by a clean re-run remediates it.

**Manual filesystem changes during a run.** If the user manually moves a file out of its source folder between the time the listing is generated and the time the move is attempted, the move attempts to operate on a stale parent. `file.moveTo(...)` succeeds — it operates on the file's current state — but the audit log's `From` field records the original parent ID as it appeared at listing time. An undo will move the file back to *that* parent, which may no longer be where the user expected. This is an acceptable edge case for a personal-scale automation.

## 17. Security and Privacy Considerations

Although the organizer is a single-user tool that runs under the user's own identity, several security and privacy properties deserve explicit treatment.

**Scope of access.** The script requires read/write access to the user's Drive and the ability to create time-based triggers. It does not require, and does not request, any access beyond the current user. The OAuth grant is to Apps Script as a platform, not to a third-party service. There is no external server that ever holds the user's data or credentials.

**Data leaves the user's account?** No. Every operation — listing, classification, moving, logging — happens within the user's own Apps Script environment, against the user's own Drive, and writes to a spreadsheet in the user's own Drive. There is no telemetry, no analytics, no external API call.

**Permission overreach?** The `'me' in owners` predicate in the listing query restricts the organizer's scope to files the user owns. Shared files — files in folders shared with the user but owned by someone else — are excluded. This avoids the surprising case where the organizer would move a colleague's file under the user's own organizational hierarchy, which would change its location for the colleague too.

**Sensitive files.** The organizer is intentionally indifferent to file content. It does not read file contents, only metadata (name, MIME type, parent IDs, modified time). A file containing sensitive material is treated the same as a file containing trivial material. This is a feature, not a bug: the alternative would require reading and classifying content, which is a much larger trust ask.

**Audit trail visibility.** The Drive Organizer Log spreadsheet contains filenames, parent folder IDs, and destination folder IDs. If the user later shares this spreadsheet (either deliberately or accidentally), they expose the names of every file the organizer has moved. The default location is the user's Drive root with no sharing settings, but users should be aware that the log is a piece of metadata that itself has confidentiality implications.

**Trigger persistence.** A scheduled trigger persists even if the script is renamed, until the user explicitly removes it via `removeExistingTriggers` or via the Apps Script triggers UI. A user who decommissions the organizer should both delete the script and remove its triggers.

## 18. Testing Strategy

Apps Script is not a typical development environment: there is no local runtime, no package manager, and no canonical unit-test framework. Testing the organizer therefore relies on a combination of dry-run validation, targeted query tests, and observation.

The `dryRun()` function is the primary validation tool. It executes the same listing query and classification logic as `organizeStaleFiles()` but performs no moves and writes no log entries. Instead, it builds a list of strings of the form `"<project> / <category> / <filename>"` and logs them. A user introducing a new configuration (different `STALE_DAYS`, different MIME mapping) runs `dryRun` first and inspects the output before invoking the real organizer.

The `testDriveQuery()` function exercises the Drive API at four levels of query complexity:

1. The trivial query (`trashed = false`) to confirm basic API access.
2. The query with the `mimeType` filter, to confirm that the folder exclusion works.
3. The query with the `'me' in owners` filter, to confirm ownership filtering.
4. The query with the date filter, to confirm that the ISO 8601 date formatting is acceptable to Drive's `q` parser.
5. The full query — all four predicates combined — to confirm that the composition works.

Each test is in its own `try`/`catch` block and logs PASS or FAIL with the relevant error message. This staged approach is helpful because the most common Drive query failure mode is a parser error caused by a single malformed predicate, and the staged tests localize the fault to a specific predicate.

Beyond these in-script tests, the audit log itself is the primary regression-detection surface. A run that produces an unusually large number of moves, or moves to unexpected destinations, can be inspected row by row in the log spreadsheet. Combined with `undoLastRun`, this makes it cheap to experiment: a user can try a new configuration, observe the result, and reverse it without lasting consequence.

There is no continuous integration. The script is small enough and self-contained enough that the cost of CI exceeds the benefit. A future expansion of the project — for example, adding a content-classification module — would justify investing in a local Node-based test harness that stubs the `DriveApp` and `SpreadsheetApp` globals.

## 19. Limitations

The organizer is deliberately scoped, and several of its limitations are direct consequences of design decisions rather than implementation oversights. We enumerate them so that future work can address them deliberately.

**Single-account, single-user.** The organizer operates only on the current Apps Script user's Drive. There is no facility for managing multiple accounts from one project, no facility for organizing on behalf of a different user, and no facility for organizing a shared drive.

**No content-based classification.** A file's category is determined entirely by its MIME type. A PDF that is structurally a presentation, a `.docx` that is structurally a spreadsheet, or a `.txt` that contains source code are all classified by their format, not by their content.

**Coarse project signal.** Project assignment depends on the parent folder's name. Files in deeply nested folder hierarchies still use only the *immediate* parent's name; the broader hierarchy is invisible. A file at `/Work/Clients/AcmeCorp/2024/proposal.docx` is assigned the project "2024", not "AcmeCorp" or "Clients".

**No de-duplication.** The organizer does not detect or collapse duplicates. A file that exists twice under the same name in two folders will be moved to two different destinations (one under each project) and remain a duplicate after organization.

**No deletion recommendations.** The organizer does not suggest files for deletion. It only moves them. A user who wants to reduce their Drive footprint must do so manually.

**No reorganization of folders.** The organizer moves files, not folders. A folder of stale files is not itself relocated; only its individual files are.

**No file-renaming.** Despite the visual `1.1.1 | name.ext` scheme suggested in early designs, the current implementation does not actually rename files. The numbering applies only to the folder structure. Files retain their original names.

**Coarse time threshold.** A single `STALE_DAYS` value applies to all files. There is no per-category or per-project threshold (e.g. images stale after 30 days, documents stale after 180 days).

**Apps Script platform constraints.** The 6-minute execution limit is the most prominent, but Apps Script also imposes daily quotas on Drive API calls, on email sending (irrelevant here), on URL fetches (irrelevant), and on the number of triggers per script. Very large Drives may run up against the Drive API quota and require runs to be spread across multiple days.

## 20. Future Work

Several enhancements are plausible and largely independent of one another.

**Content-aware classification.** A natural extension is to read file content for certain MIME types (PDF, plaintext, source code) and use simple heuristics (keyword presence, file size, page count) to refine classification. This would, for example, distinguish "invoices" from "contracts" within the Documents category. The risk is twofold: increased per-file latency (content reads are slow) and increased trust footprint (the script would have to read file bodies, not just metadata).

**Hierarchical project signal.** Instead of using only the immediate parent folder's name as the project signal, walk up the folder hierarchy a few levels and use the most specific name that does not match a category-suggesting word (e.g. "Documents", "Receipts"). This would correctly attribute `/Work/Clients/AcmeCorp/2024/proposal.docx` to "AcmeCorp" rather than "2024".

**Per-category staleness thresholds.** Different categories age differently. Receipts may be useful indefinitely; meeting notes may be archival within 30 days. A small extension would let `CONFIG.STALE_DAYS` be either a number (current behavior) or a per-category object.

**Deletion recommendations.** A new function, `recommendDeletions()`, could surface candidate files for deletion based on size, age, and category. It would write recommendations to a separate spreadsheet and never delete anything itself.

**Multi-account support.** Apps Script does not natively support multiple Google accounts in one project. A workaround would be to deploy the same script under each account separately, which is straightforward but requires manual setup per account. A more ambitious option would be to package the script as a Workspace Add-on with explicit per-installation configuration.

**Folder pruning after undo.** After an undo, the empty folders in `Organized Projects/` could be deleted. A small `pruneEmptyFolders()` function would walk the hierarchy and delete any folder with no children.

**Programmatic file renaming.** The folder-level numbering scheme could be extended to file names: rename `proposal.docx` to `1.1.1 | proposal.docx` on move, and reverse the rename on undo. This is cosmetic but potentially useful for users who navigate Drive primarily by filename rather than folder structure.

**Web dashboard.** A small HTML dashboard, served via Apps Script's web app feature, could surface the last run's statistics (files moved, errors, duration) and provide a single button for `undoLastRun`. This would remove the need to open the Apps Script editor for routine operations.

**Notification on completion.** An optional email or Google Chat notification at the end of each run would inform the user of how many files were moved and link to the audit log. This is a few lines of code but raises questions about user preference (always notify? only on errors? quiet hours?).

**Test harness.** A local Node.js test harness that stubs `DriveApp`, `SpreadsheetApp`, `PropertiesService`, and `ScriptApp` would allow unit testing of the classification logic and the state machine without round-tripping through Google's editor. This becomes increasingly valuable as the codebase grows.

## 21. Conclusion

The Google Drive Auto-Organizer is a small, opinionated automation that addresses a real and chronic problem in personal cloud storage: the diffusion of files across an unstructured archive. Its design favors *small mechanisms* over cleverness: a single MIME-to-category map, a single parent-folder-name project signal, a single page-token watermark, a single spreadsheet audit log. Each mechanism is simple enough to fit in a paragraph of explanation, and the combination is robust enough to handle Drives of arbitrary size on a runtime with a hard six-minute execution ceiling.

The engineering contribution of the system is not in the classification — which is intentionally trivial — but in the *runtime model*. The watermark-and-continuation pattern, the audit-log-as-undo substrate, and the strict separation of state from triggers are reusable patterns for any Apps Script automation that needs to manipulate large collections of user data over potentially many invocations. The patterns generalize beyond Apps Script: they are equally applicable to any serverless runtime with a wall-clock execution ceiling, and the principle of "audit log as undo substrate" generalizes to any mutating data pipeline.

The user-facing contribution is perhaps more important. The organizer requires no rules, no setup beyond five minutes of click-through, and no ongoing maintenance. It runs in the background and produces a predictable, browsable, numbered hierarchy that the user can rely on to locate any older file. When it does the wrong thing, a single undo call reverses the most recent run completely. These properties — automatic, predictable, reversible — are the right defaults for a tool that handles a user's personal archive.

Future work can extend the system in several directions without disturbing the core design. Content-aware classification, hierarchical project signals, per-category staleness, and deletion recommendations are all additive features that can be implemented independently. The architecture is designed to accommodate them: each new classifier slots into `detectCategoryFromMime` (or a successor function), each new schedule slots into `setupBiweeklyTrigger` (or a successor), and each new operation slots into the audit log with its own `Level`.

The fundamental claim of this paper is that small, deliberate, well-bounded automations are a powerful response to the entropy of personal data. The Google Drive Auto-Organizer is one such automation. The hope is that the patterns it embodies — and the engineering discipline it represents — are useful well beyond the specific case it addresses.

---

## Appendix A — Function Reference

The following functions are defined in `google-drive-organizer/Code.gs`.

### A.1 Top-Level Functions (User-Invokable)

**`organizeStaleFiles()`**
Runs the organizer. Reads `PropertiesService["ORGANIZER_STATE"]` to determine whether this is a fresh run or a resumption. Iterates over stale files in pages of 50, moving each into the appropriate project/category folder, until either all files are processed or the internal time budget is exhausted. On budget exhaustion, persists the page token and schedules a one-off continuation trigger.

**`dryRun()`**
Computes the same projection as `organizeStaleFiles` but without performing any moves. Logs the projection to the Apps Script execution log and returns it as a newline-joined string. Safe to run repeatedly.

**`setupBiweeklyTrigger()`**
Removes any existing triggers for `organizeStaleFiles` and installs a new recurring trigger that fires every `CONFIG.TRIGGER_INTERVAL_DAYS` days at 3 AM in the user's timezone.

**`removeExistingTriggers()`**
Deletes all project triggers whose handler function is `organizeStaleFiles`, recurring and one-off alike. Useful for fully decommissioning the schedule.

**`undoLastRun()`**
Identifies the most recent logical run by scanning the audit log from the bottom for the most recent `MOVED` row, then iterates forward through every `MOVED` row from that run and moves each file back to its original parent. Appends an `UNDO` row to the log summarizing the result.

**`resetState()`**
Deletes the `ORGANIZER_STATE` property and removes any one-off continuation triggers. Used to recover from corrupted state.

**`testDriveQuery()`**
Runs a sequence of Drive list queries of increasing complexity, logging PASS or FAIL for each. Used to diagnose Drive API integration problems.

### A.2 Internal Helper Functions

**`getProjectName(item, cache)`**
Returns the project name for a file. Uses parent folder name if the parent is not the Drive root; falls back to a filename-prefix heuristic; finally falls back to `"Uncategorized"`.

**`detectCategoryFromMime(mimeType)`**
Returns the category name for a MIME type, by iterating over `CONFIG.MIME_CATEGORIES` in insertion order. Returns `"Other"` if no category matches.

**`cleanName(name)`**
Normalizes a folder or project name: replaces underscores and hyphens with spaces, collapses runs of whitespace, trims, and truncates to 40 characters.

**`isTimedOut(startTime)`**
Returns true if the elapsed time since `startTime` exceeds `CONFIG.MAX_RUNTIME_MS`.

**`scheduleResume()`**
Creates a one-off time-based trigger that fires after 60 seconds and re-invokes `organizeStaleFiles`.

**`getOrCreateRootFolder()`**
Returns the root organized folder, creating it if it does not exist.

**`getOrCreateSubfolder(parentFolder, name)`**
Returns the named subfolder of the given parent, creating it if it does not exist.

**`getOrCreateLogSheet()`**
Returns the audit log spreadsheet, creating it (with header row) if it does not exist.

**`logEntry(sheet, runId, level, message, details)`**
Appends a single row to the audit log spreadsheet.

**`cleanupContinuationTriggers()`**
Deletes any one-off triggers for `organizeStaleFiles`. Distinguishes one-off from recurring triggers by attempting to read their interval, which throws for one-off triggers.

---

## Appendix B — Configuration Reference

All configuration lives in the `CONFIG` object at the top of `Code.gs`.

| Key | Type | Default | Description |
|---|---|---|---|
| `STALE_DAYS` | `number` | `60` | Days since last modification to consider a file stale. |
| `ROOT_FOLDER_NAME` | `string` | `"Organized Projects"` | Top-level folder name in Drive. |
| `LOG_SHEET_NAME` | `string` | `"Drive Organizer Log"` | Audit log spreadsheet name. |
| `TRIGGER_INTERVAL_DAYS` | `number` | `14` | Recurring trigger interval in days. |
| `MAX_RUNTIME_MS` | `number` | `270000` | Internal time budget per invocation in milliseconds. |
| `MIME_CATEGORIES` | `object` | See Section 7.3 | Map of category name to list of MIME types. |

---

## Appendix C — Log Schema

The audit log is a Google Sheets spreadsheet named according to `CONFIG.LOG_SHEET_NAME`. It has five columns:

| Column | Type | Description |
|---|---|---|
| Timestamp | Date | Server time the row was written. |
| Run ID | String | The logical run's ISO 8601 start timestamp. |
| Level | String | One of `INFO`, `MOVED`, `ERROR`, `UNDO`. |
| Message | String | Short human-readable summary. |
| Details | String | Pipe-separated `Key: value` pairs. |

The recognized levels and the structure of their `Details` column:

- **`INFO`** — Run lifecycle markers (start, pause, resume, complete). Details column may be empty or contain a short status message.
- **`MOVED`** — A single file was moved. Details contain `From: <parentId> | To: <folderId> | FileID: <fileId> | Project: <name> | Category: <name>`.
- **`ERROR`** — A move attempt failed. Details contain `<exception message> | FileID: <fileId>`.
- **`UNDO`** — Undo summary. Details column may be empty. The message records how many files were restored and the source run ID.

---

## Appendix D — Drive API Query Reference

The organizer issues a single Drive list query, repeated with successive page tokens until exhaustion. The query has four predicates, joined with `and`:

| Predicate | Purpose |
|---|---|
| `modifiedTime < '<cutoffISO>'` | Select files older than the staleness threshold. |
| `trashed = false` | Exclude files in the user's trash. |
| `mimeType != 'application/vnd.google-apps.folder'` | Exclude folders. |
| `'me' in owners` | Restrict to files owned by the current user. |

The list request uses these parameters:

| Parameter | Value | Purpose |
|---|---|---|
| `q` | composed query above | Filter expression. |
| `pageSize` | `50` | Items per page. |
| `fields` | `"files(id,name,mimeType,parents),nextPageToken"` | Restrict response payload to fields the organizer uses. |
| `pageToken` | (carried) | Resume position from the previous page. |

The `fields` parameter is important: it dramatically reduces the bytes returned per page and is a Google-recommended practice. The organizer requests only the four file fields it needs (`id`, `name`, `mimeType`, `parents`) plus the pagination cursor (`nextPageToken`).

The cutoff timestamp is formatted as ISO 8601 with the fractional-second suffix stripped:

```javascript
var dateStr = cutoffDate.toISOString().replace(/\.\d{3}Z$/, "");
```

This produces `"2026-04-21T13:45:00"` (without the `Z` and milliseconds), which is accepted by Drive's `q` parser. The full ISO 8601 with milliseconds is sometimes rejected, depending on platform version, so the stripped form is more reliable.

---

## Appendix E — Glossary

**Apps Script.** Google's managed JavaScript runtime for automating Google Workspace products. Functions written in Apps Script can be invoked manually from the editor, on a schedule via time-based triggers, on user events (e.g. spreadsheet edits), or via HTTP if deployed as a web app.

**`DriveApp`.** The Apps Script global object that exposes the high-level Drive API (folder and file manipulation, sharing, search).

**`Drive.Files.list`.** The Apps Script wrapper for the Drive REST API v3's `files.list` method. Returns a page of files matching a query.

**`PropertiesService`.** The Apps Script global object that provides a small persistent key/value store, scoped to the user, the document, or the script.

**`ScriptApp`.** The Apps Script global object that manages script-level configuration, including triggers.

**`SpreadsheetApp`.** The Apps Script global object for manipulating Google Sheets.

**MIME type.** A standard label for a file's format, such as `application/pdf` or `image/png`. Drive records the MIME type as part of every file's metadata.

**Page token.** An opaque string returned by paginated Drive API responses that the client passes back on the next request to receive the next page. Tokens are stable across invocations as long as the underlying query is unchanged.

**Time-based trigger.** An Apps Script trigger that fires on a schedule. Can be recurring (e.g. every N days) or one-off (fires once at a specified delay).

**Watermark.** A persisted position in a stream of work, allowing a process to resume from where it left off. In this system, the watermark is the Drive page token plus the logical run timestamp.

---

## References

The organizer references no external academic literature directly. The following resources are recommended reading for engineers extending or maintaining the system:

1. Google Workspace Developer Documentation — *Apps Script Reference*. Authoritative documentation for `DriveApp`, `SpreadsheetApp`, `ScriptApp`, and `PropertiesService`.
2. Google Drive API v3 — *Files: list* and *Files: update*. Reference documentation for the Drive REST API methods that underlie the organizer's behavior.
3. Google Drive API — *Search query terms*. Reference for the `q` parameter syntax used in `Drive.Files.list`.
4. Google Apps Script — *Quotas for Google Services*. Documents the daily and per-invocation limits relevant to long-running scripts.
5. Google Apps Script — *Manifest and project configuration*. Useful for advanced users who want to enable additional services or manage authentication scopes explicitly.

---

*End of paper.*
