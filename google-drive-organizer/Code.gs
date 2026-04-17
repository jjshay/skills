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

function organizeStaleFiles() {
  var props = PropertiesService.getScriptProperties();
  var startTime = new Date();

  var log = getOrCreateLogSheet();
  var rootFolder = getOrCreateRootFolder();
  var rootFolderId = rootFolder.getId();

  var raw = props.getProperty("ORGANIZER_STATE");
  var pageToken = null;
  var runTimestamp;
  var totalMoved = 0;

  if (raw) {
    var saved = JSON.parse(raw);
    pageToken = saved.pageToken || null;
    runTimestamp = saved.runTimestamp;
    totalMoved = saved.totalMoved || 0;
    logEntry(log, runTimestamp, "INFO",
      "--- Resuming (page token exists, " + totalMoved + " moved so far) ---", "");
  } else {
    runTimestamp = new Date().toISOString();
    logEntry(log, runTimestamp, "INFO", "--- Run started ---", "");
  }

  var cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.STALE_DAYS);

  var dateStr = cutoffDate.toISOString().replace(/\.\d{3}Z$/, "");
  var query = "modifiedTime < '" + dateStr + "'"
    + " and trashed = false"
    + " and mimeType != 'application/vnd.google-apps.folder'"
    + " and 'me' in owners";

  var parentCache = {};
  var movedThisBatch = 0;

  do {
    if (isTimedOut(startTime)) {
      props.setProperty("ORGANIZER_STATE", JSON.stringify({
        pageToken: pageToken,
        runTimestamp: runTimestamp,
        totalMoved: totalMoved
      }));
      logEntry(log, runTimestamp, "INFO",
        "--- Paused: " + totalMoved + " total moved. Resuming in 1 min. ---", "");
      scheduleResume();
      return;
    }

    var params = {
      q: query,
      pageSize: 50,
      fields: "files(id,name,mimeType,parents),nextPageToken"
    };
    if (pageToken) params.pageToken = pageToken;

    var results = Drive.Files.list(params);
    var items = results.files || [];

    for (var i = 0; i < items.length; i++) {
      if (isTimedOut(startTime)) {
        props.setProperty("ORGANIZER_STATE", JSON.stringify({
          pageToken: pageToken,
          runTimestamp: runTimestamp,
          totalMoved: totalMoved
        }));
        logEntry(log, runTimestamp, "INFO",
          "--- Paused mid-page: " + totalMoved + " total moved. Resuming in 1 min. ---", "");
        scheduleResume();
        return;
      }

      var item = items[i];
      var parentIds = item.parents || [];
      var isExcluded = false;
      for (var j = 0; j < parentIds.length; j++) {
        if (parentIds[j] === rootFolderId) { isExcluded = true; break; }
      }
      if (isExcluded) continue;

      var projectName = getProjectName(item, parentCache);
      var categoryName = detectCategoryFromMime(item.mimeType);

      var projectFolder = getOrCreateSubfolder(rootFolder, projectName);
      var categoryFolder = getOrCreateSubfolder(projectFolder, categoryName);

      try {
        var file = DriveApp.getFileById(item.id);
        var originalParentId = parentIds.length > 0 ? parentIds[0] : "root";
        file.moveTo(categoryFolder);
        totalMoved++;

        logEntry(log, runTimestamp, "MOVED",
          item.name,
          "From: " + originalParentId + " | To: " + categoryFolder.getId()
            + " | FileID: " + item.id
            + " | Project: " + projectName + " | Category: " + categoryName
        );
      } catch (e) {
        logEntry(log, runTimestamp, "ERROR",
          "Failed: " + item.name,
          e.message + " | FileID: " + item.id
        );
      }
    }

    pageToken = results.nextPageToken || null;
  } while (pageToken);

  props.deleteProperty("ORGANIZER_STATE");
  cleanupContinuationTriggers();
  logEntry(log, runTimestamp, "INFO", "--- Run complete ---",
    "Organized " + totalMoved + " files total");
}

function getProjectName(item, cache) {
  var parentIds = item.parents || [];
  if (parentIds.length === 0) return "Uncategorized";

  var parentId = parentIds[0];
  if (cache[parentId]) return cache[parentId];

  try {
    var parentFolder = DriveApp.getFolderById(parentId);
    var parentName = parentFolder.getName();
    if (parentName !== "My Drive" && parentName !== "Drive") {
      var clean = cleanName(parentName);
      cache[parentId] = clean;
      return clean;
    }
  } catch (e) {}

  var prefixMatch = item.name.match(/^([A-Za-z]+[\s_-]?[A-Za-z]*)/);
  if (prefixMatch && prefixMatch[1].length > 2) {
    return cleanName(prefixMatch[1]);
  }

  return "Uncategorized";
}

function detectCategoryFromMime(mimeType) {
  var categories = Object.keys(CONFIG.MIME_CATEGORIES);
  for (var i = 0; i < categories.length; i++) {
    var cat = categories[i];
    if (cat === "Other") continue;
    if (CONFIG.MIME_CATEGORIES[cat].indexOf(mimeType) !== -1) return cat;
  }
  return "Other";
}

function cleanName(name) {
  return name.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim().substring(0, 40);
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

function setupBiweeklyTrigger() {
  removeExistingTriggers();
  ScriptApp.newTrigger("organizeStaleFiles")
    .timeBased()
    .everyDays(CONFIG.TRIGGER_INTERVAL_DAYS)
    .atHour(3)
    .create();
  Logger.log("Trigger created: every " + CONFIG.TRIGGER_INTERVAL_DAYS + " days at 3 AM.");
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

function resetState() {
  PropertiesService.getScriptProperties().deleteProperty("ORGANIZER_STATE");
  cleanupContinuationTriggers();
  Logger.log("State cleared and continuation triggers removed.");
}

function dryRun() {
  var cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.STALE_DAYS);
  var rootFolder = getOrCreateRootFolder();
  var rootFolderId = rootFolder.getId();
  var parentCache = {};

  var output = [];
  var totalFiles = 0;
  var dateStr = cutoffDate.toISOString().replace(/\.\d{3}Z$/, "");
  var query = "modifiedTime < '" + dateStr + "'"
    + " and trashed = false"
    + " and mimeType != 'application/vnd.google-apps.folder'"
    + " and 'me' in owners";

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
      if (isExcluded) continue;

      var project = getProjectName(item, parentCache);
      var category = detectCategoryFromMime(item.mimeType);
      output.push(project + " / " + category + " / " + item.name);
      totalFiles++;
    }
    pageToken = results.nextPageToken || null;
  } while (pageToken);

  output.unshift("=== DRY RUN -- " + totalFiles + " stale files found ===\n");
  Logger.log(output.join("\n"));
  return output.join("\n");
}

function testDriveQuery() {
  try {
    var r1 = Drive.Files.list({ pageSize: 1, q: "trashed = false", fields: "files(id,name)" });
    Logger.log("Test 1 PASSED: basic query works. Found: " + (r1.files || []).length);
  } catch (e) {
    Logger.log("Test 1 FAILED: " + e.message);
  }

  try {
    var r2 = Drive.Files.list({ pageSize: 1, q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'", fields: "files(id,name)" });
    Logger.log("Test 2 PASSED: mimeType filter works. Found: " + (r2.files || []).length);
  } catch (e) {
    Logger.log("Test 2 FAILED: " + e.message);
  }

  try {
    var r3 = Drive.Files.list({ pageSize: 1, q: "trashed = false and 'me' in owners", fields: "files(id,name)" });
    Logger.log("Test 3 PASSED: owners filter works. Found: " + (r3.files || []).length);
  } catch (e) {
    Logger.log("Test 3 FAILED: " + e.message);
  }

  try {
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    var dateStr = cutoff.toISOString().replace(/\.\d{3}Z$/, "");
    var r4 = Drive.Files.list({ pageSize: 1, q: "modifiedTime < '" + dateStr + "'", fields: "files(id,name)" });
    Logger.log("Test 4 PASSED: date filter works. Found: " + (r4.files || []).length);
  } catch (e) {
    Logger.log("Test 4 FAILED: " + e.message);
  }

  try {
    var cutoff2 = new Date();
    cutoff2.setDate(cutoff2.getDate() - 60);
    var dateStr2 = cutoff2.toISOString().replace(/\.\d{3}Z$/, "");
    var fullQuery = "modifiedTime < '" + dateStr2 + "' and trashed = false and mimeType != 'application/vnd.google-apps.folder' and 'me' in owners";
    Logger.log("Full query: " + fullQuery);
    var r5 = Drive.Files.list({ pageSize: 1, q: fullQuery, fields: "files(id,name)" });
    Logger.log("Test 5 PASSED: full query works. Found: " + (r5.files || []).length);
  } catch (e) {
    Logger.log("Test 5 FAILED: " + e.message);
  }
}
