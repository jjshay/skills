var CONFIG = {
  STALE_DAYS: 60,
  ROOT_FOLDER_NAME: "Organized Projects",
  LOG_SHEET_NAME: "Drive Organizer Log",
  TRIGGER_INTERVAL_DAYS: 14,
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,
  MIME_CATEGORIES: {
    "Documents": [
      "application/vnd.google-apps.document",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain"
    ],
    "Spreadsheets": [
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv"
    ],
    "Presentations": [
      "application/vnd.google-apps.presentation",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ],
    "Images": [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/svg+xml",
      "image/webp"
    ],
    "Videos": [
      "video/mp4",
      "video/quicktime",
      "video/x-msvideo",
      "video/webm"
    ],
    "Audio": [
      "audio/mpeg",
      "audio/wav",
      "audio/ogg"
    ],
    "Code": [
      "application/json",
      "text/html",
      "text/css",
      "application/javascript",
      "application/xml"
    ],
    "Archives": [
      "application/zip",
      "application/x-rar-compressed",
      "application/gzip",
      "application/x-tar"
    ],
    "Other": []
  }
};

// ── Main Entry Point ──

function organizeStaleFiles() {
  var props = PropertiesService.getScriptProperties();
  var startTime = new Date();

  var log = getOrCreateLogSheet();
  var rootFolder = getOrCreateRootFolder();
  var rootFolderId = rootFolder.getId();

  var state = loadState(props);

  if (state.phase === "scan") {
    if (!state.runTimestamp) {
      state.runTimestamp = new Date().toISOString();
      logEntry(log, state.runTimestamp, "INFO", "--- Run started ---", "");
    }

    var scanResult = scanStaleFiles(state, rootFolderId, startTime);
    state = scanResult.state;

    if (scanResult.timedOut) {
      saveState(props, state);
      logEntry(log, state.runTimestamp, "INFO",
        "--- Scan paused: " + state.scannedFiles.length + " files found so far. Resuming in 1 min. ---", "");
      scheduleResume();
      return;
    }

    logEntry(log, state.runTimestamp, "INFO",
      "Scan complete: " + state.scannedFiles.length + " stale files found", "");

    if (state.scannedFiles.length === 0) {
      logEntry(log, state.runTimestamp, "INFO", "No stale files to organize", "");
      clearState(props);
      return;
    }

    var assignments = buildAssignments(state.scannedFiles, rootFolder);
    state.phase = "move";
    state.assignments = assignments;
    state.scannedFiles = null;
    state.moveIndex = 0;

    if (isTimedOut(startTime)) {
      saveState(props, state);
      logEntry(log, state.runTimestamp, "INFO",
        "--- Classification done. " + assignments.length + " files to move. Resuming in 1 min. ---", "");
      scheduleResume();
      return;
    }
  }

  if (state.phase === "move") {
    var total = state.assignments.length;
    var idx = state.moveIndex || 0;

    logEntry(log, state.runTimestamp, "INFO",
      "--- Moving files (" + (total - idx) + " remaining) ---", "");

    while (idx < total) {
      if (isTimedOut(startTime)) {
        state.moveIndex = idx;
        saveState(props, state);
        logEntry(log, state.runTimestamp, "INFO",
          "--- Paused: " + idx + "/" + total + " moved. Resuming in 1 min. ---", "");
        scheduleResume();
        return;
      }

      var a = state.assignments[idx];
      try {
        var file = DriveApp.getFileById(a.fileId);
        var projectFolder = getOrCreateSubfolder(rootFolder, a.projectFolderName);
        var categoryFolder = getOrCreateSubfolder(projectFolder, a.categoryFolderName);

        var originalParentId = "root";
        var parents = file.getParents();
        if (parents.hasNext()) {
          originalParentId = parents.next().getId();
        }

        file.moveTo(categoryFolder);

        logEntry(log, state.runTimestamp, "MOVED",
          a.fileNumber + " | " + a.fileName,
          "From: " + originalParentId + " | To: " + categoryFolder.getId() + " | FileID: " + a.fileId
        );
      } catch (e) {
        logEntry(log, state.runTimestamp, "ERROR",
          "Failed: " + (a.fileName || a.fileId),
          e.message + " | FileID: " + a.fileId
        );
      }
      idx++;
    }

    clearState(props);
    cleanupContinuationTriggers();
    logEntry(log, state.runTimestamp, "INFO", "--- Run complete ---",
      "Organized " + total + " files");
  }
}

// ── Scan Phase (paginated, resumable) ──

function scanStaleFiles(state, excludeFolderId, startTime) {
  var cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.STALE_DAYS);

  var query = 'modifiedTime < "' + cutoffDate.toISOString() + '"'
    + ' and trashed = false'
    + ' and mimeType != "application/vnd.google-apps.folder"'
    + ' and "me" in owners';

  var pageToken = state.scanPageToken || null;
  var files = state.scannedFiles || [];

  do {
    if (isTimedOut(startTime)) {
      state.scanPageToken = pageToken;
      state.scannedFiles = files;
      return { state: state, timedOut: true };
    }

    var params = {
      q: query,
      pageSize: 100,
      fields: "files(id,name,mimeType,parents),nextPageToken"
    };
    if (pageToken) params.pageToken = pageToken;

    var results = Drive.Files.list(params);
    var items = results.files || [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var parentIds = item.parents || [];
      var isExcluded = false;
      for (var j = 0; j < parentIds.length; j++) {
        if (parentIds[j] === excludeFolderId) { isExcluded = true; break; }
      }
      if (!isExcluded) {
        files.push({
          id: item.id,
          name: item.name,
          mimeType: item.mimeType,
          parentId: parentIds.length > 0 ? parentIds[0] : null
        });
      }
    }

    pageToken = results.nextPageToken || null;
  } while (pageToken);

  state.scanPageToken = null;
  state.scannedFiles = files;
  return { state: state, timedOut: false };
}

// ── Classification Phase ──

function buildAssignments(scannedFiles, rootFolder) {
  var projectMap = {};

  for (var i = 0; i < scannedFiles.length; i++) {
    var f = scannedFiles[i];
    var projectName = detectProjectFromMetadata(f);
    var categoryName = detectCategoryFromMime(f.mimeType);

    if (!projectMap[projectName]) projectMap[projectName] = {};
    if (!projectMap[projectName][categoryName]) projectMap[projectName][categoryName] = [];
    projectMap[projectName][categoryName].push(f);
  }

  var assignments = [];
  var projectNumber = getNextProjectNumber(rootFolder);
  var projectKeys = Object.keys(projectMap).sort();

  for (var p = 0; p < projectKeys.length; p++) {
    var projectName = projectKeys[p];
    var categories = projectMap[projectName];
    var pNum = projectNumber + p;

    var categoryKeys = Object.keys(categories).sort();
    for (var c = 0; c < categoryKeys.length; c++) {
      var categoryName = categoryKeys[c];
      var files = categories[categoryName];
      var cNum = pNum + "." + (c + 1);

      for (var f = 0; f < files.length; f++) {
        assignments.push({
          fileId: files[f].id,
          fileName: files[f].name,
          projectFolderName: pNum + " - " + projectName,
          categoryFolderName: cNum + " - " + categoryName,
          fileNumber: cNum + "." + (f + 1)
        });
      }
    }
  }

  return assignments;
}

function detectProjectFromMetadata(fileMeta) {
  if (fileMeta.parentId) {
    try {
      var parentFolder = DriveApp.getFolderById(fileMeta.parentId);
      var parentName = parentFolder.getName();
      if (parentName !== "My Drive" && parentName !== "Drive") {
        return cleanProjectName(parentName);
      }
    } catch (e) {}
  }

  var prefixMatch = fileMeta.name.match(/^([A-Za-z]+[\s_-]?[A-Za-z]*)/);
  if (prefixMatch && prefixMatch[1].length > 2) {
    return cleanProjectName(prefixMatch[1]);
  }

  return "Uncategorized";
}

function detectCategoryFromMime(mimeType) {
  var categories = Object.keys(CONFIG.MIME_CATEGORIES);
  for (var i = 0; i < categories.length; i++) {
    var cat = categories[i];
    if (cat === "Other") continue;
    if (CONFIG.MIME_CATEGORIES[cat].indexOf(mimeType) !== -1) {
      return cat;
    }
  }
  return "Other";
}

function cleanProjectName(name) {
  return name
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 40);
}

// ── State Management ──

function loadState(props) {
  var raw = props.getProperty("ORGANIZER_STATE");
  if (raw) return JSON.parse(raw);
  return { phase: "scan", runTimestamp: null, scannedFiles: [], scanPageToken: null };
}

function saveState(props, state) {
  props.setProperty("ORGANIZER_STATE", JSON.stringify(state));
}

function clearState(props) {
  props.deleteProperty("ORGANIZER_STATE");
}

function isTimedOut(startTime) {
  return (new Date() - startTime) > CONFIG.MAX_RUNTIME_MS;
}

function scheduleResume() {
  ScriptApp.newTrigger("organizeStaleFiles")
    .timeBased()
    .after(60 * 1000)
    .create();
}

// ── Folder Helpers ──

function getOrCreateRootFolder() {
  var folders = DriveApp.getFoldersByName(CONFIG.ROOT_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
}

function getOrCreateSubfolder(parentFolder, name) {
  var folders = parentFolder.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parentFolder.createFolder(name);
}

function getNextProjectNumber(rootFolder) {
  var subfolders = rootFolder.getFolders();
  var maxNum = 0;
  while (subfolders.hasNext()) {
    var match = subfolders.next().getName().match(/^(\d+)/);
    if (match) {
      var num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return maxNum + 1;
}

// ── Logging ──

function getOrCreateLogSheet() {
  var files = DriveApp.getFilesByName(CONFIG.LOG_SHEET_NAME);
  if (files.hasNext()) {
    return SpreadsheetApp.open(files.next()).getActiveSheet();
  }
  var ss = SpreadsheetApp.create(CONFIG.LOG_SHEET_NAME);
  var sheet = ss.getActiveSheet();
  sheet.appendRow(["Timestamp", "Run ID", "Level", "Message", "Details"]);
  sheet.setFrozenRows(1);
  sheet.getRange("1:1").setFontWeight("bold");
  return sheet;
}

function logEntry(sheet, runId, level, message, details) {
  sheet.appendRow([new Date(), runId, level, message, details]);
}

// ── Undo ──

function undoLastRun() {
  var log = getOrCreateLogSheet();
  var data = log.getDataRange().getValues();

  var lastRunId = null;
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][2] === "MOVED") { lastRunId = data[i][1]; break; }
  }

  if (!lastRunId) { Logger.log("No moves found to undo."); return; }

  var undone = 0;
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

  logEntry(log, new Date().toISOString(), "UNDO",
    "Undid " + undone + " moves from run " + lastRunId, "");
  Logger.log("Undo complete: " + undone + " files restored.");
}

// ── Trigger Management ──

function setupBiweeklyTrigger() {
  removeExistingTriggers();
  ScriptApp.newTrigger("organizeStaleFiles")
    .timeBased()
    .everyDays(CONFIG.TRIGGER_INTERVAL_DAYS)
    .atHour(3)
    .create();
  Logger.log("Bi-weekly trigger created: runs every "
    + CONFIG.TRIGGER_INTERVAL_DAYS + " days at 3 AM.");
}

function removeExistingTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "organizeStaleFiles") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function cleanupContinuationTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var t = triggers[i];
    if (t.getHandlerFunction() === "organizeStaleFiles"
        && t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK
        && t.getEventType() === ScriptApp.EventType.CLOCK) {
      var isOneOff = true;
      try { t.getMinuteInterval(); isOneOff = false; } catch(e) {}
      try { t.getDayInterval(); isOneOff = false; } catch(e) {}
      if (isOneOff) ScriptApp.deleteTrigger(t);
    }
  }
}

// ── Reset (if a run gets stuck) ──

function resetState() {
  PropertiesService.getScriptProperties().deleteProperty("ORGANIZER_STATE");
  cleanupContinuationTriggers();
  Logger.log("State cleared and continuation triggers removed.");
}

// ── Dry Run ──

function dryRun() {
  var cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.STALE_DAYS);
  var rootFolder = getOrCreateRootFolder();
  var rootFolderId = rootFolder.getId();

  var files = [];
  var query = 'modifiedTime < "' + cutoffDate.toISOString() + '"'
    + ' and trashed = false'
    + ' and mimeType != "application/vnd.google-apps.folder"'
    + ' and "me" in owners';

  var pageToken = null;
  do {
    var params = {
      q: query,
      pageSize: 100,
      fields: "files(id,name,mimeType,parents),nextPageToken"
    };
    if (pageToken) params.pageToken = pageToken;

    var results = Drive.Files.list(params);
    var items = results.files || [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var parentIds = item.parents || [];
      var isExcluded = false;
      for (var j = 0; j < parentIds.length; j++) {
        if (parentIds[j] === rootFolderId) { isExcluded = true; break; }
      }
      if (!isExcluded) {
        files.push({
          id: item.id,
          name: item.name,
          mimeType: item.mimeType,
          parentId: parentIds.length > 0 ? parentIds[0] : null
        });
      }
    }
    pageToken = results.nextPageToken || null;
  } while (pageToken);

  var assignments = buildAssignments(files, rootFolder);

  var output = ["=== DRY RUN — " + files.length + " stale files found ===\n"];
  var currentProject = "";

  for (var i = 0; i < assignments.length; i++) {
    var a = assignments[i];
    if (a.projectFolderName !== currentProject) {
      currentProject = a.projectFolderName;
      output.push(currentProject);
    }
    output.push("  " + a.categoryFolderName);
    output.push("    " + a.fileNumber + " | " + a.fileName);
  }

  Logger.log(output.join("\n"));
  return output.join("\n");
}
