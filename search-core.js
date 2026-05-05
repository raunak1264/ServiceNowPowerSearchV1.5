// ─────────────────────────────────────────────────────────────────────────────
//  ServiceNow Power Search — search-core.js  v1.5.0
//  Shared logic module (popup only)
//  IIFE wrapper prevents top-level const names from colliding with the
//  destructuring declarations in popup.js (shared script scope).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_RECENT          = 8;
const MAX_DROPDOWN        = 50;
const MAX_INHERITANCE_DEPTH = 12;          // kept here for documentation clarity
const CACHE_TTL_MS        = 60 * 60 * 1000; // 1 hour — fields are busted manually via ↻

const OP_SYMBOLS = {
  '=':          '=',
  '!=':         '≠',
  'LIKE':       '~',
  'STARTSWITH': '^=',
  'ENDSWITH':   '$=',
  'CONTAINS':   '⊂',
  'ISEMPTY':    '=∅',
  'ISNOTEMPTY': '≠∅',
  'IN':         '∈',
  'GT':         '>',
  'LT':         '<',
  'GTE':        '≥',
  'LTE':        '≤',
};

const NO_VAL_OPS = new Set(['ISEMPTY', 'ISNOTEMPTY']);

// ── State factory — call per panel instance ──────────────────────────────────
function createState() {
  return {
    snTab:           null,
    instanceUrl:     null,
    fields:          [],
    selectedField:   null,
    dropdownKeyIndex:-1,
    fieldsLoading:   false,
    recentSearches:  [],
    savedTemplates:  [],
    lastKnownTable:  null,
    tabWatchInterval:null,
    fetchRequestId:  0,       // race-condition guard: incremented on each fetch
    conditions:      [],      // multi-condition builder: [{id, field_name, field_label, op, value, join}]
    currentJoin:     'AND',   // join operator for the NEXT condition added ('AND' | 'OR')
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function getTableFromUrl(url) {
  if (!url) return null;
  const m = url.match(/[/?]([a-zA-Z0-9_]+)_list\.do/) ||
            url.match(/target\/([a-zA-Z0-9_]+)_list/)  ||
            url.match(/target\/([a-zA-Z0-9_]+)\.do/);
  return m ? m[1] : null;
}

// ── Query building ────────────────────────────────────────────────────────────
// Combines committed conditions (with AND/OR joins) + current partial + advanced.
function buildQuery(state, els) {
  const s = currentSearchState(state, els);
  let query = '';

  // Append a clause with the correct separator (^OR for OR, ^ for AND).
  // The first clause never needs a separator — join is ignored when query is empty.
  function appendClause(clause, join) {
    if (!clause) return;
    if (!query) { query = clause; return; }
    query += (join === 'OR' ? '^OR' : '^') + clause;
  }

  // Committed multi-conditions (each carries its own join type)
  for (const cond of state.conditions) {
    if (NO_VAL_OPS.has(cond.op))  appendClause(`${cond.field_name}${cond.op}`, cond.join);
    else if (cond.value)           appendClause(`${cond.field_name}${cond.op}${cond.value}`, cond.join);
  }

  // Current (partial) condition — always AND-joined to committed conditions
  if (s.field_name) {
    if (NO_VAL_OPS.has(s.op))     appendClause(`${s.field_name}${s.op}`, 'AND');
    else if (s.value)              appendClause(`${s.field_name}${s.op}${s.value}`, 'AND');
  }

  if (s.advanced) appendClause(s.advanced, 'AND');
  return query;
}

function buildUrl(instanceUrl, table, query) {
  const base = instanceUrl || '';
  return `${base}/now/nav/ui/classic/params/target/${encodeURIComponent(table)}_list.do?sysparm_query=${encodeURIComponent(query)}`;
}

function getTable(els) {
  const v = els.tableSelect.value;
  return v === 'custom' ? els.customTableInput.value.trim() : v;
}

function currentSearchState(state, els) {
  return {
    table:       getTable(els),
    field_name:  state.selectedField?.name  || '',
    field_label: state.selectedField?.label || '',
    op:          els.operatorSelect.value,
    value:       els.valueInput.value.trim(),
    advanced:    els.advancedQuery.value.trim(),
    conditions:  [...state.conditions],
  };
}

// ── Multi-condition helpers ───────────────────────────────────────────────────
// Returns true if a condition was added, false if inputs were incomplete.
function addCondition(state, els) {
  const s = currentSearchState(state, els);
  if (!s.field_name) return false;
  if (!NO_VAL_OPS.has(s.op) && !s.value) return false;
  state.conditions.push({
    id:          Date.now(),
    field_name:  s.field_name,
    field_label: s.field_label,
    op:          s.op,
    value:       s.value,
    // First condition has no meaningful join (nothing precedes it); subsequent
    // conditions use whatever the user selected in the AND/OR toggle.
    join:        state.conditions.length === 0 ? 'AND' : (state.currentJoin || 'AND'),
  });
  state.currentJoin = 'AND'; // reset to AND-default after each commit
  return true;
}

function removeCondition(state, id) {
  state.conditions = state.conditions.filter((c) => c.id !== id);
}

// ── Chip labels ───────────────────────────────────────────────────────────────
function chipLabel(s) {
  if (s.field_name) {
    const sym = OP_SYMBOLS[s.op] || s.op;
    if (NO_VAL_OPS.has(s.op)) return `${s.field_name}${sym}`;
    if (s.value)               return `${s.field_name}${sym}${s.value}`;
  }
  if (s.advanced) return s.advanced;
  return s.table || 'empty';
}

function conditionLabel(c) {
  const sym = OP_SYMBOLS[c.op] || c.op;
  if (NO_VAL_OPS.has(c.op)) return `${c.field_label || c.field_name}${sym}`;
  return `${c.field_label || c.field_name}${sym}${c.value}`;
}

function chipTooltip(s) {
  const lines = [`table: ${s.table}`];
  if (s.conditions && s.conditions.length) {
    s.conditions.forEach((c) => lines.push(`cond: ${conditionLabel(c)}`));
  }
  if (s.field_name) {
    const sym = OP_SYMBOLS[s.op] || s.op;
    lines.push(`field: ${s.field_name}${sym}${NO_VAL_OPS.has(s.op) ? '' : (s.value || '')}`);
  }
  if (s.advanced) lines.push(`advanced: ${s.advanced}`);
  return lines.join('\n');
}

function searchSignature(s) {
  return JSON.stringify({ t: s.table, f: s.field_name, o: s.op, v: s.value, a: s.advanced, c: s.conditions });
}

function highlight(str, q) {
  if (!q) return esc(str);
  const idx = str.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return esc(str);
  return esc(str.slice(0, idx)) +
    `<span class="match-highlight">${esc(str.slice(idx, idx + q.length))}</span>` +
    esc(str.slice(idx + q.length));
}

// ── Template / recent storage ─────────────────────────────────────────────────
function loadTemplates(state) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['recentSearches', 'savedTemplates'], (d) => {
      state.recentSearches = d.recentSearches || [];
      state.savedTemplates = d.savedTemplates || [];
      resolve();
    });
  });
}

function persistRecent(state) { chrome.storage.local.set({ recentSearches: state.recentSearches }); }
function persistSaved(state)  { chrome.storage.local.set({ savedTemplates:  state.savedTemplates }); }

function recordRecentSearch(state, els) {
  const s = currentSearchState(state, els);
  if (!s.table) return;
  if (!s.field_name && !s.advanced && !s.conditions.length) return;
  const sig = searchSignature(s);
  state.recentSearches = state.recentSearches.filter((r) => searchSignature(r) !== sig);
  state.recentSearches.unshift(s);
  if (state.recentSearches.length > MAX_RECENT) state.recentSearches.length = MAX_RECENT;
  persistRecent(state);
}

// ── Export / Import templates ─────────────────────────────────────────────────
function exportTemplates(state) {
  return JSON.stringify({ savedTemplates: state.savedTemplates }, null, 2);
}

function importTemplates(state, jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    if (!data.savedTemplates || !Array.isArray(data.savedTemplates)) {
      return { ok: false, error: 'JSON must contain a "savedTemplates" array.' };
    }
    const existing = new Set(state.savedTemplates.map((t) => t.name));
    let added = 0;
    for (const t of data.savedTemplates) {
      if (t.name && !existing.has(t.name)) {
        state.savedTemplates.push(t);
        existing.add(t.name);
        added++;
      }
    }
    persistSaved(state);
    return { ok: true, added };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Field fetching ────────────────────────────────────────────────────────────
//  FIX: fetchRequestId guards against race conditions when the user switches
//  tables quickly — stale in-flight responses are silently discarded.
//  FIX: Cache now stores { fields, ts } with a 1-hour TTL instead of a bare
//  array. Old bare-array cache entries are still accepted (backward compat).
async function fetchFields(tableName, state, els, callbacks = {}) {
  if (!tableName) return;
  if (!state.snTab) {
    state.fields = [];
    if (callbacks.onFields) callbacks.onFields([]);
    return;
  }

  const cacheKey = `fields_v2_${state.instanceUrl}_${tableName}`;
  const raw = await new Promise((r) =>
    chrome.storage.local.get([cacheKey], (d) => r(d[cacheKey]))
  );

  // Backward-compatible cache read: old format = plain array, new format = { fields, ts }
  const cachedFields = Array.isArray(raw) ? raw : (raw?.fields || null);
  const cachedTs     = Array.isArray(raw) ? 0   : (raw?.ts     || 0);

  if (cachedFields && cachedFields.length && (Date.now() - cachedTs < CACHE_TTL_MS)) {
    state.fields = cachedFields;
    if (callbacks.onFields) callbacks.onFields(cachedFields);
    return;
  }

  // Stamp this request so we can detect stale responses
  const requestId = ++state.fetchRequestId;

  state.fieldsLoading = true;
  if (callbacks.onLoading) callbacks.onLoading(true);

  chrome.runtime.sendMessage(
    { type: 'FETCH_FIELDS', tabId: state.snTab.id, tableName },
    (resp) => {
      // Discard response if a newer request has already been issued
      if (requestId !== state.fetchRequestId) return;

      state.fieldsLoading = false;
      if (callbacks.onLoading) callbacks.onLoading(false);

      if (resp?.error && (!resp.fields || resp.fields.length === 0)) {
        const code = resp.error;
        if (callbacks.onError) {
          if (code === 'session_expired')
            callbacks.onError('Session expired — re-login on the SN tab.', 'error');
          else if (code.startsWith('http'))
            callbacks.onError(`Field fetch failed (${code}).`, 'error');
        }
        state.fields = [];
        if (callbacks.onFields) callbacks.onFields([]);
        return;
      }

      const fields     = resp?.fields || [];
      const fieldCount = resp?.count  || fields.length;
      state.fields = fields;

      if (fields.length) {
        // Write new TTL-stamped format
        chrome.storage.local.set({ [cacheKey]: { fields, ts: Date.now() } });
      }
      if (callbacks.onFields) callbacks.onFields(fields, fieldCount, resp?.tables || []);
    }
  );
}

// Clear the field cache for a specific table (used by the ↻ refresh button).
async function clearFieldCache(state, tableName) {
  const cacheKey = `fields_v2_${state.instanceUrl}_${tableName}`;
  return new Promise((resolve) => chrome.storage.local.remove([cacheKey], resolve));
}

// ── Instance detection ────────────────────────────────────────────────────────
async function detectInstance(state, els, callbacks = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, (resp) => {
      if (!resp?.tab) { resolve(null); return; }
      const tab = resp.tab;
      const url = tab.url || '';
      const m   = url.match(/^(https:\/\/[a-zA-Z0-9_-]+\.service-now\.com)/);
      if (m) {
        state.snTab       = tab;
        state.instanceUrl = m[1];
        const name = m[1].replace('https://', '').replace('.service-now.com', '');
        if (callbacks.onOnline) callbacks.onOnline(name, m[1], tab);
        chrome.storage.local.set({ lastInstance: m[1] });
        resolve(tab);
      } else {
        chrome.storage.local.get(['lastInstance'], (data) => {
          if (data.lastInstance) {
            state.instanceUrl = data.lastInstance;
            const name = data.lastInstance.replace('https://', '').replace('.service-now.com', '');
            if (callbacks.onCached) callbacks.onCached(name);
          }
          if (callbacks.onOffline) callbacks.onOffline();
          resolve(null);
        });
      }
    });
  });
}

// ── Save / restore last UI state ──────────────────────────────────────────────
function saveState(state, els, prefix = '') {
  chrome.storage.local.set({
    [`${prefix}lastTable`]:      getTable(els),
    [`${prefix}lastFieldName`]:  state.selectedField?.name  || '',
    [`${prefix}lastFieldLabel`]: state.selectedField?.label || '',
    [`${prefix}lastOp`]:         els.operatorSelect.value,
    [`${prefix}lastValue`]:      els.valueInput.value,
    [`${prefix}lastAdvanced`]:   els.advancedQuery.value,
  });
}

// FIX: wrapped inner body in try/catch so a malformed persisted value can never
// crash the popup silently — we log the error and still call resolve().
async function restoreState(state, els, prefix = '', onRestored) {
  return new Promise((resolve) => {
    const keys = [
      `${prefix}lastTable`, `${prefix}lastFieldName`, `${prefix}lastFieldLabel`,
      `${prefix}lastOp`,    `${prefix}lastValue`,     `${prefix}lastAdvanced`,
    ];
    chrome.storage.local.get(keys, (data) => {
      try {
        const t = data[`${prefix}lastTable`];
        if (t) {
          const opt = [...els.tableSelect.options].find((o) => o.value === t);
          if (opt) {
            els.tableSelect.value = t;
          } else {
            els.tableSelect.value = 'custom';
            els.customTableGroup.style.display = 'block';
            els.customTableInput.value = t;
          }
        }
        const fn = data[`${prefix}lastFieldName`];
        if (fn) {
          state.selectedField  = { name: fn, label: data[`${prefix}lastFieldLabel`] || fn };
          els.fieldInput.value = data[`${prefix}lastFieldLabel`] || fn;
          els.fieldClear.classList.add('visible');
        }
        const op = data[`${prefix}lastOp`];
        if (op && [...els.operatorSelect.options].some((o) => o.value === op)) {
          els.operatorSelect.value = op;
        }
        const val = data[`${prefix}lastValue`];
        if (val) els.valueInput.value = val;
        const adv = data[`${prefix}lastAdvanced`];
        if (adv) els.advancedQuery.value = adv;
        if (onRestored) onRestored();
      } catch (e) {
        console.warn('[SNPowerSearch] restoreState error:', e);
      }
      resolve();
    });
  });
}

// ── Export as module-like object ──────────────────────────────────────────────
window.SearchCore = {
  MAX_RECENT,
  MAX_DROPDOWN,
  MAX_INHERITANCE_DEPTH,
  CACHE_TTL_MS,
  OP_SYMBOLS,
  NO_VAL_OPS,
  createState,
  esc,
  debounce,
  getTable,
  getTableFromUrl,
  buildQuery,
  buildUrl,
  currentSearchState,
  chipLabel,
  conditionLabel,
  chipTooltip,
  searchSignature,
  highlight,
  addCondition,
  removeCondition,
  loadTemplates,
  persistRecent,
  persistSaved,
  recordRecentSearch,
  exportTemplates,
  importTemplates,
  fetchFields,
  clearFieldCache,
  detectInstance,
  saveState,
  restoreState,
};
})();
