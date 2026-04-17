# Google Drive Auto-Organizer

Automatically organizes stale Google Drive files (not modified in 60+ days) into a numbered project-based folder hierarchy. Runs every 2 weeks.

## Folder Structure

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

**Numbering:** `Project.Category.File` (e.g. `1.2.3` = Project 1, Category 2, File 3)

## How It Works

1. Finds all files you own that haven't been modified in 60+ days
2. Groups them by their parent folder name (= project) and MIME type (= category)
3. Files already inside `Organized Projects/` are skipped
4. Creates numbered folders and moves files in
5. Logs every move to a spreadsheet called "Drive Organizer Log" (with undo support)

## Setup (5 minutes)

### 1. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com)
2. Click **New project**
3. Delete the default `myFunction()` code
4. Paste the entire contents of `Code.gs` from this repo
5. Rename the project to "Drive Organizer" (click "Untitled project" at the top)

### 2. Enable the Drive API

1. In the Apps Script editor, click **Services** (+ icon) in the left sidebar
2. Scroll to **Drive API** and click **Add**
3. Keep the default identifier "Drive" and version "v2"

### 3. Test with a dry run

1. In the function dropdown (top toolbar), select `dryRun`
2. Click **Run**
3. Authorize when prompted (you'll see a consent screen — this is your own script accessing your own Drive)
4. Click **View > Logs** to see what would be organized

### 4. Run it for real

1. Select `organizeStaleFiles` from the dropdown
2. Click **Run**
3. Check your Drive for the new "Organized Projects" folder

### 5. Set up the bi-weekly schedule

1. Select `setupBiweeklyTrigger` from the dropdown
2. Click **Run**
3. Done — it will now run automatically every 14 days at 3 AM

## Undo

If you don't like a run's results:

1. Select `undoLastRun` from the dropdown
2. Click **Run**
3. All files from the most recent run are moved back to their original locations

## Configuration

Edit the `CONFIG` object at the top of `Code.gs`:

| Setting | Default | Description |
|---------|---------|-------------|
| `STALE_DAYS` | `60` | Days since last modification to consider a file stale |
| `ROOT_FOLDER_NAME` | `"Organized Projects"` | Name of the top-level folder |
| `TRIGGER_INTERVAL_DAYS` | `14` | How often the automation runs (days) |

## Category Mapping

Files are sorted by MIME type into these categories:

- **Documents** — Google Docs, PDFs, Word files, plain text
- **Spreadsheets** — Google Sheets, Excel, CSV
- **Presentations** — Google Slides, PowerPoint
- **Images** — JPEG, PNG, GIF, SVG, WebP
- **Videos** — MP4, MOV, AVI, WebM
- **Audio** — MP3, WAV, OGG
- **Code** — JSON, HTML, CSS, JS, XML
- **Archives** — ZIP, RAR, GZIP, TAR
- **Other** — Everything else

## Project Detection

Files are grouped into projects by their **parent folder name**. Files sitting directly in "My Drive" (root) are grouped by filename prefix. Anything unclassifiable goes to "Uncategorized".
