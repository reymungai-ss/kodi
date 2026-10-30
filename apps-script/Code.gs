/**
 * Kodi Sheet bridge — paste this whole file into Extensions → Apps Script
 * of the Baraka Court Google Sheet, then deploy it as a Web app
 * (Execute as: Me, Who has access: Anyone). See README.md.
 *
 * Every request is a POST with a JSON body:
 *   { "secret": "...", "action": "read" | "append" | "update" | "replace" | "ping", ... }
 * Every response is JSON: { "ok": true, ... } or { "ok": false, "error": "..." }.
 *
 * The secret is stored in Project Settings → Script properties under the
 * name SHEET_WEBAPP_SECRET. It is never written in this file.
 */

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return reply_({ ok: false, error: "bad_json" });
  }

  var expected = PropertiesService.getScriptProperties().getProperty("SHEET_WEBAPP_SECRET");
  if (!expected || !body.secret || !safeEqual_(String(body.secret), expected)) {
    return reply_({ ok: false, error: "unauthorized" });
  }

  try {
    switch (body.action) {
      case "ping":
        return reply_({ ok: true, sheet: SpreadsheetApp.getActive().getName() });
      case "read":
        return reply_(read_(body.tab));
      case "append":
        return withLock_(function () { return append_(body.tab, body.rows, body.unique_key); });
      case "update":
        return withLock_(function () { return update_(body.tab, body.match, body.set, body.unless); });
      case "replace":
        return withLock_(function () { return replace_(body.tab, body.headers, body.rows); });
      default:
        return reply_({ ok: false, error: "unknown_action" });
    }
  } catch (err) {
    return reply_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// A browser visit shows this, so you can check the deployment is alive.
function doGet() {
  return reply_({ ok: true, service: "kodi-sheet-bridge" });
}

// ---- actions ---------------------------------------------------------------

function read_(tabName) {
  var sheet = getTab_(tabName);
  var values = sheet.getDataRange().getDisplayValues();
  if (values.length === 0) return { ok: true, headers: [], rows: [] };
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = {};
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      row[headers[c]] = values[i][c];
      if (values[i][c] !== "") empty = false;
    }
    if (!empty) rows.push(row);
  }
  return { ok: true, headers: headers, rows: rows };
}

// Adds rows at the bottom. If unique_key is given (e.g. "reference") and any
// new row's value already exists in that column, nothing is written.
function append_(tabName, rows, uniqueKey) {
  if (!rows || !rows.length) return { ok: true, appended: 0 };
  var sheet = getTab_(tabName);
  var headers = headersOf_(sheet);

  if (uniqueKey) {
    var col = headers.indexOf(uniqueKey);
    if (col < 0) return { ok: false, error: "no_column:" + uniqueKey };
    var existing = {};
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, col + 1, sheet.getLastRow() - 1, 1).getDisplayValues()
        .forEach(function (r) { existing[r[0]] = true; });
    }
    for (var i = 0; i < rows.length; i++) {
      if (existing[String(rows[i][uniqueKey])]) return { ok: false, error: "duplicate" };
    }
  }

  var out = rows.map(function (r) {
    return headers.map(function (h) { return r[h] === undefined || r[h] === null ? "" : String(r[h]); });
  });
  var start = sheet.getLastRow() + 1;
  var range = sheet.getRange(start, 1, out.length, headers.length);
  range.setNumberFormat("@"); // keep everything as plain text (no date/number guessing)
  range.setValues(out);
  return { ok: true, appended: out.length };
}

// Changes cells in every row where all `match` columns are equal.
// Rows where any `unless` column is equal are left alone (used so a payment
// can only be marked success once).
function update_(tabName, match, set, unless) {
  var sheet = getTab_(tabName);
  var values = sheet.getDataRange().getDisplayValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var updated = 0;
  var skipped = 0;
  for (var i = 1; i < values.length; i++) {
    if (!rowMatches_(headers, values[i], match)) continue;
    if (unless && anyMatches_(headers, values[i], unless)) { skipped++; continue; }
    Object.keys(set || {}).forEach(function (key) {
      var c = headers.indexOf(key);
      if (c < 0) throw new Error("no_column:" + key);
      var cell = sheet.getRange(i + 1, c + 1);
      cell.setNumberFormat("@");
      cell.setValue(String(set[key]));
    });
    updated++;
  }
  return { ok: true, updated: updated, skipped: skipped };
}

// Wipes a tab (creating it if missing) and writes headers + rows.
// Used only by the seed and reset scripts.
function replace_(tabName, headers, rows) {
  if (!headers || !headers.length) return { ok: false, error: "no_headers" };
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
  sheet.clear();
  var out = [headers].concat((rows || []).map(function (r) {
    return headers.map(function (h) { return r[h] === undefined || r[h] === null ? "" : String(r[h]); });
  }));
  var range = sheet.getRange(1, 1, out.length, headers.length);
  range.setNumberFormat("@");
  range.setValues(out);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  return { ok: true, written: out.length - 1 };
}

// ---- helpers ---------------------------------------------------------------

function getTab_(tabName) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(String(tabName || ""));
  if (!sheet) throw new Error("no_tab:" + tabName);
  return sheet;
}

function headersOf_(sheet) {
  if (sheet.getLastColumn() === 0) throw new Error("no_headers");
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .map(function (h) { return String(h).trim(); });
}

function rowMatches_(headers, row, match) {
  var keys = Object.keys(match || {});
  if (!keys.length) return false; // never update every row by accident
  return keys.every(function (k) {
    var c = headers.indexOf(k);
    return c >= 0 && String(row[c]) === String(match[k]);
  });
}

function anyMatches_(headers, row, cond) {
  return Object.keys(cond).some(function (k) {
    var c = headers.indexOf(k);
    return c >= 0 && String(row[c]) === String(cond[k]);
  });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return reply_({ ok: false, error: "busy" });
  try {
    var result = fn();
    SpreadsheetApp.flush();
    return reply_(result);
  } finally {
    lock.releaseLock();
  }
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
