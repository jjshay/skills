# Skills — Automation Scripts

A collection of automation scripts for organizing and managing personal productivity workflows.

---

## Scripts

### 1. Google Drive Auto-Organizer

**Location:** [`google-drive-organizer/`](google-drive-organizer/)

**What it does:** Automatically finds Google Drive files that haven't been modified in 60+ days and organizes them into a numbered, project-based folder hierarchy using the naming convention `Project.Category.File` (e.g. `1.2.3`).

**Key features:**
- Groups files into projects by parent folder name, then into categories by file type (Documents, Spreadsheets, Presentations, Images, Videos, Audio, Code, Archives, Other)
- Batch processing with auto-continuation — handles any number of files without hitting the 6-minute Apps Script execution limit
- Full undo support — reverts the most recent run with one click
- Logging — every move is recorded in a "Drive Organizer Log" spreadsheet with original location, destination, and file ID
- Scheduled automation — runs every 14 days at 3 AM via a time-based trigger

**Functions:**

| Function | Purpose |
|----------|---------|
| `dryRun()` | Preview what would be organized without moving anything |
| `organizeStaleFiles()` | Run the organizer (processes in 4.5-min batches, auto-resumes) |
| `setupBiweeklyTrigger()` | Schedule automatic runs every 14 days |
| `undoLastRun()` | Move all files from the last run back to their original locations |
| `removeExistingTriggers()` | Cancel the scheduled automation |

**Configuration:**

| Setting | Default | Description |
|---------|---------|-------------|
| `STALE_DAYS` | `60` | Days since last modification to consider a file stale |
| `ROOT_FOLDER_NAME` | `"Organized Projects"` | Top-level folder name in Drive |
| `TRIGGER_INTERVAL_DAYS` | `14` | How often the automation runs (days) |

**Setup:** See [`google-drive-organizer/SETUP.md`](google-drive-organizer/SETUP.md) for step-by-step deployment instructions (takes ~5 minutes).

**Tech:** Google Apps Script, Drive API v3, PropertiesService for batch state persistence, SpreadsheetApp for logging.

---

## Adding New Scripts

Each script lives in its own directory with:
- The script source file(s)
- A `SETUP.md` with deployment instructions
