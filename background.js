// background.js — MV3 Service Worker
// Tab detection + script injection for ServiceNow API calls (session-safe)

// ─── Constants ───────────────────────────────────────────────────────────────
const MAX_INHERITANCE_DEPTH = 12; // max levels to walk the super_class chain

// ─── Message Router ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ tab: tabs && tabs[0] ? tabs[0] : null });
    });
    return true;
  }

  if (message.type === 'FETCH_FIELDS') {
    const { tabId, tableName } = message;
    chrome.scripting.executeScript(
      { target: { tabId }, func: fetchFieldsFromSN, args: [tableName] },
      (results) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else if (results && results[0]) {
          sendResponse(results[0].result || { fields: [], error: 'no_result' });
        } else {
          sendResponse({ fields: [], error: 'empty' });
        }
      }
    );
    return true;
  }

  // ── Reference field display-name → sys_id lookup ─────────────────────────
  if (message.type === 'FETCH_REF_LOOKUP') {
    const { tabId, refTable, query } = message;
    chrome.scripting.executeScript(
      { target: { tabId }, func: lookupRefRecords, args: [refTable, query] },
      (results) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message, records: [] });
        } else {
          sendResponse(results?.[0]?.result || { records: [] });
        }
      }
    );
    return true;
  }

  if (message.type === 'OPEN_URL') {
    const { url, newTab } = message;
    if (newTab) {
      chrome.tabs.create({ url });
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) chrome.tabs.update(tabs[0].id, { url });
      });
    }
    sendResponse({ ok: true });
    return true;
  }

});

// ─────────────────────────────────────────────────────────────────────────────
//  fetchFieldsFromSN — runs INSIDE the ServiceNow tab via executeScript.
//
//  Strategy:
//    1. Walk the super_class chain in sys_db_object (e.g. change_request →
//       task → sys_metadata). Most user-visible fields (number,
//       short_description, state, ...) live on PARENT tables, not the child.
//    2. Pull every active dictionary entry across the hierarchy in one query,
//       now including internal_type and reference for the ref-resolver feature.
//    3. Dedupe child overrides of parent fields (child wins).
//
//  Auth notes:
//    - credentials: 'same-origin' reuses the existing JSESSIONID cookie.
//    - X-Requested-With: 'XMLHttpRequest' makes SN return a JSON 401 instead
//      of an HTML login redirect, so Chrome's auth dialog never fires.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFieldsFromSN(tableName) {
  const HEADERS = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
  };

  async function safeJson(url) {
    try {
      const r = await fetch(url, { method: 'GET', credentials: 'same-origin', headers: HEADERS });
      if (!r.ok) return { error: `http_${r.status}` };
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) return { error: 'session_expired' };
      const data = await r.json();
      return { data };
    } catch (e) {
      return { error: 'network_' + (e.message || 'err') };
    }
  }

  // ── 1. Walk super_class chain via JSONv2 (session-cookie safe) ──
  //
  //  JSONv2 does NOT support dot-walking on reference fields — requesting
  //  sysparm_fields=super_class.name returns the raw sys_id of the parent
  //  record, not the table name string. We work around this with a two-step
  //  approach per level:
  //    a) Fetch the current table's record to get the super_class sys_id.
  //    b) Fetch sys_db_object by that sys_id to resolve the parent table name.
  //
  //  We deliberately stay on JSONv2 (*.do?JSONv2) for ALL requests because
  //  the REST Table API (/api/now/table/) triggers Chrome's Basic Auth dialog
  //  when the session cookie alone is present — JSONv2 accepts the cookie
  //  and returns a JSON 401 instead, which we handle gracefully.
  //
  const MAX_DEPTH = 12; // mirrored here since this runs in an isolated context
  const tables = [];
  let current = tableName;
  let depth = 0;

  while (current && depth < MAX_DEPTH) {
    if (tables.includes(current)) break;
    tables.push(current);

    // Step a: get super_class sys_id for `current`
    const q = encodeURIComponent(`name=${current}`);
    const url = `/sys_db_object_list.do?JSONv2&sysparm_action=getRecords&sysparm_query=${q}&sysparm_fields=name,super_class&sysparm_limit=1`;
    const { data: d1, error: e1 } = await safeJson(url);
    if (e1 || !d1) break;
    const rec = (d1.records && d1.records[0]) || (d1.result && d1.result[0]);
    if (!rec) break;

    // super_class comes back as a raw sys_id string in JSONv2
    const superClassSysId = rec.super_class || null;
    if (!superClassSysId) break;

    // Step b: resolve sys_id → table name
    const q2 = encodeURIComponent(`sys_id=${superClassSysId}`);
    const url2 = `/sys_db_object_list.do?JSONv2&sysparm_action=getRecords&sysparm_query=${q2}&sysparm_fields=name&sysparm_limit=1`;
    const { data: d2, error: e2 } = await safeJson(url2);
    if (e2 || !d2) break;
    const rec2 = (d2.records && d2.records[0]) || (d2.result && d2.result[0]);
    if (!rec2 || !rec2.name) break;

    current = rec2.name;
    depth++;
  }

  if (tables.length === 0) tables.push(tableName);

  // ── 2. Fetch fields for the entire hierarchy ────────────────────
  //  Now fetches internal_type + reference so the popup can detect reference
  //  fields and show the display-name → sys_id resolver UI.
  const tableQ = tables.map((t) => `name=${t}`).join('^OR');
  const fullQ  = encodeURIComponent(`${tableQ}^active=true^elementISNOTEMPTY`);
  const fieldsUrl = `/sys_dictionary_list.do?JSONv2&sysparm_action=getRecords&sysparm_query=${fullQ}&sysparm_fields=element,column_label,name,internal_type,reference&sysparm_limit=3000`;

  const { data, error } = await safeJson(fieldsUrl);
  if (error || !data) {
    return { fields: [], error: error || 'no_data', tables };
  }

  const rows = data.records || data.result || [];

  // ── 3. Dedupe — child overrides parent ──────────────────────────
  const priority = {};
  tables.forEach((t, i) => { priority[t] = tables.length - i; }); // child = highest

  const byElement = new Map();
  for (const f of rows) {
    if (!f.element) continue;
    const score = priority[f.name] || 0;
    const existing = byElement.get(f.element);
    if (!existing || score > existing._score) {
      byElement.set(f.element, {
        name:      f.element,
        label:     f.column_label || f.element,
        type:      f.internal_type || '',
        reference: f.reference    || '',
        _score:    score,
        _table:    f.name,
      });
    }
  }

  const fields = [...byElement.values()]
    .map(({ name, label, type, reference, _table }) => ({ name, label, type, reference, table: _table }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { fields, tables, count: fields.length };
}

// ─────────────────────────────────────────────────────────────────────────────
//  lookupRefRecords — runs INSIDE the SN tab; resolves display names to sys_ids
//  for reference-type fields. Used by the reference field resolver UI.
// ─────────────────────────────────────────────────────────────────────────────
async function lookupRefRecords(refTable, query) {
  //  FIX 1: STARTSWITH instead of LIKE.
  //  LIKE performs a full table scan (checks every row for substring match).
  //  STARTSWITH hits the name index directly — 10-50x faster on large tables
  //  like sys_user. We run two parallel fetches: one STARTSWITH (fast, prefix
  //  matches at top) and one CONTAINS (catches mid-string matches), then merge
  //  and dedupe so the user still sees "John Smith" even if they type "hn Sm".
  const HEADERS = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
  };

  async function safeGet(url) {
    try {
      const r = await fetch(url, { method: 'GET', credentials: 'same-origin', headers: HEADERS });
      if (!r.ok) return [];
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) return [];
      const data = await r.json();
      return data.records || data.result || [];
    } catch { return []; }
  }

  const base = `/${refTable}_list.do?JSONv2&sysparm_action=getRecords&sysparm_fields=sys_id,name&sysparm_limit=5`;

  // Fire both queries in parallel — Promise.all waits for the faster one too
  const qStart    = encodeURIComponent(`nameSTARTSWITH${query}^active=true`);
  const qContains = encodeURIComponent(`nameCONTAINS${query}^active=true^nameNOT STARTSWITH${query}`);

  const [starts, contains] = await Promise.all([
    safeGet(`${base}&sysparm_query=${qStart}`),
    safeGet(`${base}&sysparm_query=${qContains}`),
  ]);

  // Merge: STARTSWITH results come first (more relevant), then CONTAINS
  const seen    = new Set();
  const records = [];
  for (const r of [...starts, ...contains]) {
    if (r.sys_id && !seen.has(r.sys_id)) {
      seen.add(r.sys_id);
      records.push(r);
      if (records.length >= 8) break;
    }
  }

  return { records };
}
