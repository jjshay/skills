var CONFIG = {
  STALE_DAYS: 60,
  ROOT_FOLDER_NAME: "Organized Projects",
  LOG_SHEET_NAME: "Drive Organizer Log",
  TRIGGER_INTERVAL_DAYS: 14,
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

function organizeStaleFiles() {
  var props = PropertiesService.getScriptProperties();
  var state = props.getProperty("ORGANIZER_STATE");
  var startTime = new Date();
  var MAX_RUNTIME_MS = 4.5 * 60 * 1000;

  var log = getOrCreateLogSheet();
  var rootFolder = getOrCreateRootFolder();
  var cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.STALE_DAYS);

  var runTimestamp, fileIds, projectAssignments;

  if (state) {
    var parsed = JSON.parse(state);
    runTimestamp = parsed.runTimestamp;
    fileIds = parsed.fileIds;
    projectAssignments = parsed.projectAssignments;
    logEntry(log, runTimestamp, "INFO",
      "--- Resuming batch (" + fileIds.length + " files remaining) ---", "");
  } else {
    runTimestamp = new Date().toISOString();
    logEntry(log, runTimestamp, "INFO", "--- Run started ---", "");

    var staleFiles = findStaleFiles(cutoffDate, rootFolder.getId());
    if (staleFiles.length === 0) {
      logEntry(log, runTimestamp, "INFO", "No stale files found", "");
      return;
    }

    logEntry(log, runTimestamp, "INFO", "Found " + staleFiles.length + " stale files", "");

    var projectMap = classifyFilesIntoProjects(staleFiles);
    var projectNumber = getNextProjectNumber(rootFolder);

    fileIds = [];
    projectAssignments = [];
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
          fileIds.push(files[f].getId());
          projectAssignments.push({
            projectFolderName: pNum + " - " + projectName,
            categoryFolderName: cNum + " - " + categoryName,
            fileNumber: cNum + "." + (f + 1)
          });
        }
      }
    }
  }

  var processed = 0;
  while (fileIds.length > 0) {
    if (new Date() - startTime > MAX_RUNTIME_MS) {
      var remaining = fileIds.length;
      props.setProperty("ORGANIZER_STATE", JSON.stringify({
        runTimestamp: runTimestamp,
        fileIds: fileIds,
        projectAssignments: projectAssignments
      }));

      logEntry(log, runTimestamp, "INFO",
        "--- Paused: " + processed + " moved, " + remaining + " remaining. Auto-resuming in 1 min. ---", "");

      ScriptApp.newTrigger("organizeStaleFiles")
        .timeBased()
        .after(60 * 1000)
        .create();
      return;
    }

    var fileId = fileIds.shift();
    var assignment = projectAssignments.shift();

    try {
      var file = DriveApp.getFileById(fileId);
      var projectFolder = getOrCreateSubfolder(rootFolder, assignment.projectFolderName);
      var categoryFolder = getOrCreateSubfolder(projectFolder, assignment.categoryFolderName);

      var originalParents = file.getParents();
      var originalParentId = "root";
      if (originalParents.hasNext()) {
        originalParentId = originalParents.next().getId();
      }

      file.moveTo(categoryFolder);
      processed++;

      logEntry(log, runTimestamp, "MOVED",
        assignment.fileNumber + " | " + file.getName(),
        "From: " + originalParentId + " | To: " + categoryFolder.getId() + " | FileID: " + fileId
      );
    } catch (e) {
      logEntry(log, runTimestamp, "ERROR",
        "Failed to move file " + fileId,
        e.message
      );
    }
  }

  props.deleteProperty("ORGANIZER_STATE");
  cleanupContinuationTriggers();
  logEntry(log, runTimestamp, "INFO", "--- Run complete ---",
    "Processed " + processed + " files in this batch");
}

function cleanupContinuationTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var trigger = triggers[i];
    if (trigger.getHandlerFunction() === "organizeStaleFiles"
        && trigger.getTriggerSource() === ScriptApp.TriggerSource.CLOCK
        && trigger.getEventType() === ScriptApp.EventType.CLOCK) {
      var isOneOff = true;
      try { trigger.getMinuteInterval(); isOneOff = false; } catch(e) {}
      try { trigger.getDayInterval(); isOneOff = false; } catch(e) {}
      if (isOneOff) ScriptApp.deleteTrigger(trigger);
    }
  }
}

function findStaleFiles(cutoffDate, excludeFolderId) {
  var files = [];
  var query = 'modifiedTime < "' + cutoffDate.toISOString() + '"'
    + ' and trashed = false'
    + ' and mimeType != "application/vnd.google-apps.folder"'
    + ' and "me" in owners';

  var pageToken = null;
  do {
    var params = {
      q: query,
      pageSize: 500,
      fields: "files(id,name,mimeType,modifiedTime,parents),nextPageToken"
    };
    if (pageToken) params.pageToken = pageToken;

    var results = Drive.Files.list(params);
    var items = results.files || [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isInsideFolder(item, excludeFolderId)) {
        try {
          files.push(DriveApp.getFileById(item.id));
        } catch (e) {
          // skip inaccessible files
        }
      }
    }
    pageToken = results.nextPageToken;
  } while (pageToken);

  return files;
}

function isInsideFolder(fileMetadata, folderId) {
  var parents = fileMetadata.parents || [];
  for (var i = 0; i < parents.length; i++) {
    if (parents[i] === folderId) return true;
  }
  return false;
}

function classifyFilesIntoProjects(files) {
  var projectMap = {};

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var projectName = detectProject(file);
    var categoryName = detectCategory(file);

    if (!projectMap[projectName]) {
      projectMap[projectName] = {};
    }
    if (!projectMap[projectName][categoryName]) {
      projectMap[projectName][categoryName] = [];
    }
    projectMap[projectName][categoryName].push(file);
  }

  return projectMap;
}

function detectProject(file) {
  var parents = file.getParents();
  if (parents.hasNext()) {
    var parentFolder = parents.next();
    var parentName = parentFolder.getName();
    if (parentName !== "My Drive" && parentName !== "Drive") {
      return cleanProjectName(parentName);
    }
  }

  var name = file.getName();
  var prefixMatch = name.match(/^([A-Za-z]+[\s_-]?[A-Za-z]*)/);
  if (prefixMatch && prefixMatch[1].length > 2) {
    return cleanProjectName(prefixMatch[1]);
  }

  return "Uncategorized";
}

function cleanProjectName(name) {
  return name
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 40);
}

function detectCategory(file) {
  var mimeType = file.getMimeType();

  var categories = Object.keys(CONFIG.MIME_CATEGORIES);
  for (var i = 0; i < categories.length; i++) {
    var cat = categories[i];
    if (cat === "Other") continue;
    var mimes = CONFIG.MIME_CATEGORIES[cat];
    if (mimes.indexOf(mimeType) !== -1) {
      return cat;
    }
  }

  return "Other";
}

function getOrCreateRootFolder() {
  var folders = DriveApp.getFoldersByName(CONFIG.ROOT_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
}

function getOrCreateSubfolder(parentFolder, name) {
  var folders = parentFolder.getFoldersByName(name);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parentFolder.createFolder(name);
}

function getNextProjectNumber(rootFolder) {
  var subfolders = rootFolder.getFolders();
  var maxNum = 0;
  while (subfolders.hasNext()) {
    var folder = subfolders.next();
    var match = folder.getName().match(/^(\d+)/);
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
    if (data[i][2] === "MOVED") {
      lastRunId = data[i][1];
      break;
    }
  }

  if (!lastRunId) {
    Logger.log("No moves found to undo.");
    return;
  }

  var undone = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] !== lastRunId || data[i][2] !== "MOVED") continue;

    var details = data[i][4];
    var fromMatch = details.match(/From:\s*(\S+)/);
    var fileMatch = details.match(/FileID:\s*(\S+)/);

    if (fromMatch && fileMatch) {
      try {
        var file = DriveApp.getFileById(fileMatch[1]);
        var originalParent;
        if (fromMatch[1] === "root") {
          originalParent = DriveApp.getRootFolder();
        } else {
          originalParent = DriveApp.getFolderById(fromMatch[1]);
        }
        file.moveTo(originalParent);
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

// ── Trigger Setup ──

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

// ── Manual Test / Dry Run ──

function dryRun() {
  var cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.STALE_DAYS);
  var rootFolder = getOrCreateRootFolder();

  var staleFiles = findStaleFiles(cutoffDate, rootFolder.getId());
  var projectMap = classifyFilesIntoProjects(staleFiles);

  var output = [];
  output.push("=== DRY RUN — " + staleFiles.length + " stale files found ===\n");

  var projectNum = getNextProjectNumber(rootFolder);
  var projectKeys = Object.keys(projectMap).sort();

  for (var p = 0; p < projectKeys.length; p++) {
    var projectName = projectKeys[p];
    var categories = projectMap[projectName];
    var pNum = projectNum + p;
    output.push(pNum + " - " + projectName);

    var categoryKeys = Object.keys(categories).sort();
    for (var c = 0; c < categoryKeys.length; c++) {
      var categoryName = categoryKeys[c];
      var files = categories[categoryName];
      var cNum = pNum + "." + (c + 1);
      output.push("  " + cNum + " - " + categoryName);

      for (var f = 0; f < files.length; f++) {
        var fNum = cNum + "." + (f + 1);
        output.push("    " + fNum + " | " + files[f].getName());
      }
    }
    output.push("");
  }

  Logger.log(output.join("\n"));
  return output.join("\n");
}
