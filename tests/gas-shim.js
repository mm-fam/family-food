// A small in-memory stand-in for the Apps Script services Code.gs uses (SpreadsheetApp, Utilities, Session,
// LockService, PropertiesService, ContentService, MailApp, ScriptApp), so the real backend can run under Node.
// Good enough for smoke tests: values only, no formatting; a leading ' on a written string is dropped like
// Sheets does (the text stays text). Formula cells written with setFormulasR1C1 read back as ''.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeSheet(ssObj, name, rows) {
  const data = rows.map((r) => r.slice());
  const formulas = {}; // "r,c" -> formula text (for checks)
  const width = () => data.reduce((m, r) => Math.max(m, r.length), 0);
  const put = (r, c, v) => {
    while (data.length < r) data.push([]);
    const row = data[r - 1];
    while (row.length < c) row.push('');
    if (typeof v === 'string' && v.charAt(0) === "'") v = v.slice(1);
    row[c - 1] = v;
  };
  const sh = {
    _data: data, _formulas: formulas,
    getName: () => name,
    getSheetId: () => name.length,
    getLastRow: () => data.length,
    getLastColumn: () => width(),
    setFrozenRows: () => sh,
    appendRow: (vals) => { data.push([]); vals.forEach((v, i) => put(data.length, i + 1, v)); return sh; },
    deleteRow: (r) => { data.splice(r - 1, 1); return sh; },
    getDataRange: () => sh.getRange(1, 1, Math.max(1, data.length), Math.max(1, width())),
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
          const row = data[r - 1 + i] || [];
          const v = row[c - 1 + j];
          return v === undefined ? '' : v;
        })),
        setValue: (v) => { put(r, c, v); },
        setValues: (vals) => { vals.forEach((row, i) => row.forEach((v, j) => put(r + i, c + j, v))); },
        setFormulasR1C1: (vals) => { vals.forEach((row, i) => row.forEach((f, j) => { formulas[(r + i) + ',' + (c + j)] = f; put(r + i, c + j, ''); })); },
        setNumberFormat: () => {},
      };
    },
  };
  return sh;
}

function makeSpreadsheet(tabs) {
  const sheets = {};
  const ssObj = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(ssObj, n, [])),
    getSheets: () => Object.values(sheets),
    getUrl: () => 'https://example.invalid/sheet',
    _sheets: sheets,
  };
  Object.keys(tabs).forEach((n) => (sheets[n] = makeSheet(ssObj, n, tabs[n])));
  return ssObj;
}

function pad(n) { return String(n).padStart(2, '0'); }
// Utilities.formatDate for the patterns Code.gs uses (yyyy, MM, dd, HH, mm, ss, quoted literals).
function formatDate(d, tz, pattern) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss|EEE/g, (m, lit) => {
    if (lit !== undefined) return lit;
    return { yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second, EEE: parts.weekday }[m];
  });
}

// Load Code.gs into a fresh context over these tabs. Returns the context (all backend functions are on it).
function loadBackend(tabs, props) {
  const ssObj = makeSpreadsheet(tabs);
  const sent = [];
  const ctx = {
    console, Date, Math, JSON, String, Number, Object, Array, RegExp, Error, isNaN, parseInt, parseFloat, Intl, encodeURIComponent,
    SpreadsheetApp: { getActive: () => ssObj, getActiveSpreadsheet: () => ssObj },
    Utilities: { formatDate: formatDate, sleep: () => {} },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props || {})[k] || null, setProperties: (o) => Object.assign(props || {}, o), setProperty: (k, v) => { (props || {})[k] = v; } }) },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => t, _text: t }), MimeType: { JSON: 'json' } },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail: (o) => sent.push(o) },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }) }) }) },
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'Code.gs' });
  ctx._ss = ssObj;
  ctx._mail = sent;
  // Call the web app the way a phone does, and get the parsed reply.
  ctx.call = (req) => JSON.parse(vm.runInContext('handle(' + JSON.stringify(req) + ')', ctx));
  return ctx;
}

module.exports = { loadBackend, makeSpreadsheet };
