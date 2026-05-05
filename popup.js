// ─────────────────────────────────────────────────────────────────────────────
//  ServiceNow Power Search — popup.js  v1.5.0
//  Popup-specific wiring; shared logic lives in search-core.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const {
  NO_VAL_OPS, OP_SYMBOLS, MAX_DROPDOWN,
  createState, esc, debounce, getTable, buildQuery, buildUrl,
  currentSearchState, chipLabel, conditionLabel, chipTooltip,
  highlight, loadTemplates, persistRecent, persistSaved,
  recordRecentSearch, fetchFields, clearFieldCache, detectInstance,
  saveState, restoreState, addCondition, removeCondition,
  getTableFromUrl, exportTemplates, importTemplates,
} = window.SearchCore;

// ── State + element refs ─────────────────────────────────────────────────────
const state = createState();

const $ = (id) => document.getElementById(id);
const els = {
  // Instance / header
  instanceBadge:       $('instanceBadge'),
  instanceDot:         $('instanceDot'),
  instanceName:        $('instanceName'),
  warningBanner:       $('warningBanner'),
  // Table
  tableSelect:         $('tableSelect'),
  customTableGroup:    $('customTableGroup'),
  customTableInput:    $('customTableInput'),
  // Multi-condition builder
  conditionsContainer: $('conditionsContainer'),
  conditionsChips:     $('conditionsChips'),
  conditionCountBadge: $('conditionCountBadge'),
  clearConditionsBtn:  $('clearConditionsBtn'),
  addConditionBtn:     $('addConditionBtn'),
  // Field autocomplete
  fieldInput:          $('fieldInput'),
  fieldClear:          $('fieldClear'),
  fieldDropdown:       $('fieldDropdown'),
  fieldLoading:        $('fieldLoadingIndicator'),
  fieldRefreshBtn:     $('fieldRefreshBtn'),
  // Op / value
  operatorSelect:      $('operatorSelect'),
  valueInput:          $('valueInput'),
  // Reference resolver
  refResolverGroup:    $('refResolverGroup'),
  refNameInput:        $('refNameInput'),
  refResults:          $('refResults'),
  // Advanced
  advancedQuery:       $('advancedQuery'),
  clearAdvBtn:         $('clearAdvBtn'),
  // Templates
  recentChips:         $('recentChips'),
  clearRecentBtn:      $('clearRecentBtn'),
  saveTemplateBtn:     $('saveTemplateBtn'),
  savePrompt:          $('savePrompt'),
  saveNameInput:       $('saveNameInput'),
  confirmSaveBtn:      $('confirmSaveBtn'),
  cancelSaveBtn:       $('cancelSaveBtn'),
  savedChips:          $('savedChips'),
  // Import / export
  exportTemplatesBtn:  $('exportTemplatesBtn'),
  importTemplatesBtn:  $('importTemplatesBtn'),
  importModal:         $('importModal'),
  importJson:          $('importJson'),
  confirmImportBtn:    $('confirmImportBtn'),
  cancelImportBtn:     $('cancelImportBtn'),
  // Preview / status / actions
  queryPreview:        $('queryPreview'),
  statusArea:          $('statusArea'),
  searchBtn:           $('searchBtn'),
  clearAllBtn:         $('clearAllBtn'),
  // AND/OR join toggle
  joinToggle:          $('joinToggle'),
};

// ── Debounced save (FIX: was called on every keystroke) ──────────────────────
const debouncedSave = debounce(() => saveState(state, els), 350);

// ── AND/OR join toggle helpers ────────────────────────────────────────────────
// setJoinToggle: updates both state.currentJoin and the button UI atomically.
function setJoinToggle(join) {
  state.currentJoin = join;
  els.joinToggle.querySelectorAll('.join-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.join === join);
  });
}

// The toggle is only meaningful once there is ≥1 committed condition.
function syncJoinToggle() {
  els.joinToggle.style.display = state.conditions.length > 0 ? 'flex' : 'none';
}

// Wire button clicks
els.joinToggle.querySelectorAll('.join-btn').forEach((btn) => {
  btn.addEventListener('click', () => setJoinToggle(btn.dataset.join));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Status + preview
// ─────────────────────────────────────────────────────────────────────────────
function showStatus(msg, type = 'info', duration = 2500) {
  const icons = { info: '◈', success: '✓', error: '✗', warn: '⚠' };
  els.statusArea.innerHTML = `<div class="status-bar ${type}"><span class="status-icon">${icons[type] || '◈'}</span>${esc(msg)}</div>`;
  if (duration > 0) setTimeout(() => { els.statusArea.innerHTML = ''; }, duration);
}

function updatePreview() {
  const s = currentSearchState(state, els);
  const table = s.table;
  const allEmpty = !table && !s.field_name && !s.advanced && !state.conditions.length;

  if (allEmpty) {
    els.queryPreview.innerHTML = `<span style="color:var(--text-muted);">—</span><button class="copy-btn" id="copyQueryBtn" title="Copy URL">⧉</button>`;
    attachCopy(); return;
  }

  let qHtml = '';

  // Helper: appends a rendered condition to qHtml with the right separator
  function appendCondHtml(condHtml, join, isFirst) {
    if (!condHtml) return;
    if (isFirst || !qHtml) { qHtml += condHtml; return; }
    const sepHtml = join === 'OR'
      ? `<span class="qs-sep qs-or-sep">^OR</span>`
      : `<span class="qs-sep">^</span>`;
    qHtml += sepHtml + condHtml;
  }

  // Committed conditions (each carries its own join type)
  state.conditions.forEach((cond, i) => {
    const sym = OP_SYMBOLS[cond.op] || cond.op;
    const valPart = NO_VAL_OPS.has(cond.op) ? '' : `<span class="qs-val">${esc(cond.value)}</span>`;
    const condHtml = `<span class="qs-field">${esc(cond.field_label || cond.field_name)}</span><span class="qs-op">${esc(sym)}</span>${valPart}`;
    appendCondHtml(condHtml, cond.join, i === 0);
  });

  // Current partial condition (always AND-joined)
  if (s.field_name) {
    const sym = OP_SYMBOLS[s.op] || s.op;
    if (NO_VAL_OPS.has(s.op)) {
      appendCondHtml(`<span class="qs-field">${esc(s.field_name)}</span><span class="qs-op">${esc(s.op)}</span>`, 'AND', !qHtml);
    } else if (s.value) {
      appendCondHtml(`<span class="qs-field">${esc(s.field_name)}</span><span class="qs-op">${esc(sym)}</span><span class="qs-val">${esc(s.value)}</span>`, 'AND', !qHtml);
    }
  }
  if (s.advanced) appendCondHtml(`<span class="qs-adv">${esc(s.advanced)}</span>`, 'AND', !qHtml);

  if (!qHtml) qHtml = `<span style="color:var(--text-muted);">empty</span>`;

  els.queryPreview.innerHTML =
    `<span class="qs-table">${esc(table || '?')}</span><span class="qs-arrow"> → </span>${qHtml}` +
    `<button class="copy-btn" id="copyQueryBtn" title="Copy URL">⧉</button>`;
  attachCopy();
}

function attachCopy() {
  const btn = $('copyQueryBtn');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const url = buildUrl(state.instanceUrl, getTable(els), buildQuery(state, els));
    navigator.clipboard.writeText(url).then(() => {
      btn.textContent = '✓'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '⧉'; btn.classList.remove('copied'); }, 1200);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Multi-condition builder
// ─────────────────────────────────────────────────────────────────────────────
function renderConditions() {
  const count = state.conditions.length;
  els.conditionsContainer.style.display = count ? 'block' : 'none';
  els.conditionCountBadge.textContent   = count;

  els.conditionsChips.innerHTML = state.conditions.map((c, i) => {
    const label = conditionLabel(c);
    // Show a join badge BEFORE every chip except the first
    const joinBadge = i > 0
      ? `<span class="cond-join-badge ${c.join === 'OR' ? 'or' : 'and'}">${c.join || 'AND'}</span>`
      : '';
    return `${joinBadge}<div class="condition-chip" data-id="${c.id}">
      <span class="cond-chip-label" title="${esc(c.field_name + (NO_VAL_OPS.has(c.op)?c.op:c.op+c.value))}">${esc(label)}</span>
      <button class="cond-chip-del" data-id="${c.id}" title="Remove condition">✕</button>
    </div>`;
  }).join('');

  syncJoinToggle();

  els.conditionsChips.querySelectorAll('.cond-chip-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      // Double-click confirm pattern (no window.confirm)
      if (btn.classList.contains('armed')) {
        removeCondition(state, id);
        renderConditions();
        updatePreview();
      } else {
        btn.classList.add('armed');
        btn.textContent = '?';
        setTimeout(() => {
          if (btn.classList.contains('armed')) {
            btn.classList.remove('armed');
            btn.textContent = '✕';
          }
        }, 2000);
      }
    });
  });
}

function handleAddCondition() {
  const ok = addCondition(state, els);
  if (!ok) {
    showStatus('Select a field and enter a value first.', 'error', 2000);
    return;
  }
  // Reset current inputs ready for the next condition
  state.selectedField = null;
  els.fieldInput.value = '';
  els.fieldClear.classList.remove('visible');
  els.valueInput.value = '';
  els.refResolverGroup.style.display = 'none';
  els.refNameInput.value = '';
  els.refResults.style.display = 'none';
  setJoinToggle('AND'); // reset toggle UI to AND-default
  renderConditions();
  updatePreview();
  els.fieldInput.focus();
}

els.addConditionBtn.addEventListener('click', handleAddCondition);
els.clearConditionsBtn.addEventListener('click', () => {
  state.conditions = [];
  setJoinToggle('AND');
  renderConditions();
  updatePreview();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Field dropdown
// ─────────────────────────────────────────────────────────────────────────────
function renderDropdown(fields, query = '') {
  const dd = els.fieldDropdown;
  if (state.fieldsLoading) {
    dd.innerHTML = `<div class="dropdown-loading"><span class="spinner"></span> Loading fields…</div>`;
    dd.classList.add('open'); return;
  }
  if (!fields.length) {
    dd.innerHTML = query
      ? `<div class="dropdown-empty">No fields matching "${esc(query)}"</div>`
      : `<div class="dropdown-empty">No fields — open a SN tab to load</div>`;
    dd.classList.add('open'); return;
  }
  dd.innerHTML = fields.slice(0, MAX_DROPDOWN).map((f, i) => {
    const lh = query ? highlight(f.label, query) : esc(f.label);
    const nh = query ? highlight(f.name,  query) : esc(f.name);
    const typeTag = f.type === 'reference' ? `<span class="field-type-tag">REF</span>` : '';
    return `<div class="dropdown-item" data-index="${i}" data-name="${esc(f.name)}" data-label="${esc(f.label)}">
      <span class="dropdown-item-label">${lh}${typeTag}</span>
      <span class="dropdown-item-name">${nh}</span>
    </div>`;
  }).join('');
  dd.classList.add('open');
  state.dropdownKeyIndex = -1;
  dd.querySelectorAll('.dropdown-item').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectField(item.dataset.name, item.dataset.label);
    });
  });
}

function filterDropdown(q) {
  if (!state.fields.length) { renderDropdown([], q); return; }
  const t = (q || '').toLowerCase();
  renderDropdown(
    !t ? state.fields : state.fields.filter((f) =>
      f.label.toLowerCase().includes(t) || f.name.toLowerCase().includes(t)
    ),
    q
  );
}

function closeDropdown() { els.fieldDropdown.classList.remove('open'); state.dropdownKeyIndex = -1; }

function selectField(name, label) {
  // Prefer the full field object from state.fields (has type + reference)
  const fieldObj = state.fields.find((f) => f.name === name) || { name, label };
  state.selectedField = fieldObj;
  els.fieldInput.value = label;
  els.fieldClear.classList.add('visible');
  closeDropdown();

  // Show reference resolver only if the field has a known reference table
  const isRef = fieldObj.type === 'reference' && fieldObj.reference;
  els.refResolverGroup.style.display = isRef ? 'block' : 'none';
  if (isRef) {
    els.refNameInput.value = '';
    els.refResults.style.display = 'none';
  }

  els.valueInput.focus();
  updatePreview();
  saveState(state, els);
}

function updateKbFocus(items) {
  items.forEach((el, i) => {
    el.classList.toggle('keyboard-focus', i === state.dropdownKeyIndex);
    if (i === state.dropdownKeyIndex) el.scrollIntoView({ block: 'nearest' });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reference field resolver
//
//  Optimisations vs original:
//    1. Debounce reduced 400ms → 200ms (snappier response)
//    2. Min 2-char guard — avoids firing on single letters ("J" → 1000 rows)
//    3. Per-session result cache (Map) — same query never hits SN twice
//    4. Stale-request guard (refLookupSeq) — slow out-of-order responses
//       are discarded so results never flicker or show wrong data
//    5. Loading spinner shown immediately so the UI never looks frozen
// ─────────────────────────────────────────────────────────────────────────────
const refCache     = new Map();   // key: "table:query" → records[]
let   refLookupSeq = 0;           // incremented per request; stale responses discarded

const debouncedRefLookup = debounce(() => {
  const name     = els.refNameInput.value.trim();
  const refTable = state.selectedField?.reference;

  // Guard: need tab, table, and at least 2 chars to get useful results
  if (!name || name.length < 2 || !refTable || !state.snTab) {
    els.refResults.style.display = 'none';
    return;
  }

  const cacheKey = `${refTable}:${name.toLowerCase()}`;

  // Cache hit — show instantly, no network call
  if (refCache.has(cacheKey)) {
    renderRefResults(refCache.get(cacheKey));
    return;
  }

  // Show loading state immediately so the UI feels responsive
  showRefLoading();

  // Stamp this request so we can detect and discard stale responses
  const seq = ++refLookupSeq;

  chrome.runtime.sendMessage(
    { type: 'FETCH_REF_LOOKUP', tabId: state.snTab.id, refTable, query: name },
    (resp) => {
      if (seq !== refLookupSeq) return; // stale — a newer request is already in flight
      const records = resp?.records || [];
      refCache.set(cacheKey, records);   // cache for this session
      renderRefResults(records);
    }
  );
}, 200);

function showRefLoading() {
  els.refResults.style.display = 'block';
  els.refResults.innerHTML = `<div class="ref-loading"><span class="spinner"></span> Searching…</div>`;
}

function renderRefResults(records) {
  if (!records.length) {
    els.refResults.style.display = 'none';
    return;
  }
  els.refResults.style.display = 'block';
  els.refResults.innerHTML = records.map((r) =>
    `<div class="ref-result-item" data-sysid="${esc(r.sys_id || '')}" data-name="${esc(r.name || r.sys_id || '')}">
      <span class="ref-result-name">${esc(r.name || r.sys_id || '')}</span>
      <span class="ref-result-id">${esc((r.sys_id || '').slice(0, 10))}…</span>
    </div>`
  ).join('');

  els.refResults.querySelectorAll('.ref-result-item').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      els.valueInput.value   = item.dataset.sysid;
      els.refNameInput.value = item.dataset.name;
      els.refResults.style.display = 'none';
      updatePreview();
      saveState(state, els);
    });
  });
}

els.refNameInput.addEventListener('input', debouncedRefLookup);
document.addEventListener('mousedown', (e) => {
  if (!els.refResolverGroup.contains(e.target)) {
    els.refResults.style.display = 'none';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Cache refresh button (↻)
// ─────────────────────────────────────────────────────────────────────────────
els.fieldRefreshBtn.addEventListener('click', async () => {
  const tableName = getTable(els);
  if (!tableName) { showStatus('Select a table first.', 'error', 2000); return; }
  if (!state.snTab) { showStatus('No SN tab — open a ServiceNow tab first.', 'error', 2500); return; }

  els.fieldRefreshBtn.classList.add('spinning');
  await clearFieldCache(state, tableName);
  state.fields = [];

  loadFieldsForTable(tableName, () => {
    els.fieldRefreshBtn.classList.remove('spinning');
    showStatus('Fields refreshed.', 'success', 1800);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Templates (recent + saved)
// ─────────────────────────────────────────────────────────────────────────────
function applyTemplate(t) {
  // Restore table
  const isCustom = ![...els.tableSelect.options].some((o) => o.value === t.table);
  if (isCustom) {
    els.tableSelect.value = 'custom';
    els.customTableGroup.style.display = 'block';
    els.customTableInput.value = t.table;
  } else {
    els.tableSelect.value = t.table;
    els.customTableGroup.style.display = 'none';
  }

  // Restore conditions
  state.conditions = t.conditions ? [...t.conditions] : [];
  renderConditions();

  // Restore field
  if (t.field_name) {
    state.selectedField  = { name: t.field_name, label: t.field_label || t.field_name };
    els.fieldInput.value = t.field_label || t.field_name;
    els.fieldClear.classList.add('visible');
  } else {
    state.selectedField = null;
    els.fieldInput.value = '';
    els.fieldClear.classList.remove('visible');
  }

  // Restore op
  const opOpt = [...els.operatorSelect.options].find((o) => o.value === t.op);
  if (opOpt) els.operatorSelect.value = t.op;

  // Restore value + advanced
  els.valueInput.value   = t.value    || '';
  els.advancedQuery.value = t.advanced || '';
  els.valueInput.disabled = NO_VAL_OPS.has(els.operatorSelect.value);

  // Hide ref resolver (field object from template may not have type info yet)
  els.refResolverGroup.style.display = 'none';

  state.fields = [];
  loadFieldsForTable(t.table);
  updatePreview();
  saveState(state, els);
  showStatus(`Loaded: ${chipLabel(t)}`, 'info', 1500);
}

function renderTemplates() {
  // ── Recent ──
  if (!state.recentSearches.length) {
    els.recentChips.innerHTML = `<span class="empty-hint">your recent searches will appear here</span>`;
    els.clearRecentBtn.style.display = 'none';
  } else {
    els.clearRecentBtn.style.display = 'inline';
    els.recentChips.innerHTML = state.recentSearches.map((s, i) =>
      `<div class="template-chip recent" data-idx="${i}" title="${esc(window.SearchCore.chipTooltip(s))}">
        <span class="chip-icon">⏱</span>
        <span class="chip-label">${esc(chipLabel(s))}</span>
        <span class="chip-delete" data-action="del" title="Remove">✕</span>
      </div>`
    ).join('');

    els.recentChips.querySelectorAll('.template-chip.recent').forEach((chip) => {
      const idx = parseInt(chip.dataset.idx, 10);
      chip.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-action="del"]');
        if (delBtn) {
          e.stopPropagation();
          // Double-click confirm (replaces window.confirm)
          if (delBtn.classList.contains('armed')) {
            state.recentSearches.splice(idx, 1);
            persistRecent(state);
            renderTemplates();
          } else {
            delBtn.classList.add('armed');
            delBtn.textContent = '?';
            setTimeout(() => {
              if (delBtn.classList.contains('armed')) {
                delBtn.classList.remove('armed');
                delBtn.textContent = '✕';
              }
            }, 2000);
          }
          return;
        }
        applyTemplate(state.recentSearches[idx]);
      });
    });
  }

  // ── Saved ──
  if (!state.savedTemplates.length) {
    els.savedChips.innerHTML = `<span class="empty-hint">click ＋ Save to keep a search</span>`;
  } else {
    els.savedChips.innerHTML = state.savedTemplates.map((t, i) =>
      `<div class="template-chip saved" data-idx="${i}" title="${esc(window.SearchCore.chipTooltip(t))}">
        <span class="chip-icon">★</span>
        <span class="chip-label">${esc(t.name)}</span>
        <span class="chip-delete" data-action="del" title="Delete">✕</span>
      </div>`
    ).join('');

    els.savedChips.querySelectorAll('.template-chip.saved').forEach((chip) => {
      const idx = parseInt(chip.dataset.idx, 10);
      chip.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-action="del"]');
        if (delBtn) {
          e.stopPropagation();
          // Double-click confirm (replaces window.confirm)
          if (delBtn.classList.contains('armed')) {
            state.savedTemplates.splice(idx, 1);
            persistSaved(state);
            renderTemplates();
          } else {
            delBtn.classList.add('armed');
            delBtn.textContent = '?';
            setTimeout(() => {
              if (delBtn.classList.contains('armed')) {
                delBtn.classList.remove('armed');
                delBtn.textContent = '✕';
              }
            }, 2000);
          }
          return;
        }
        applyTemplate(state.savedTemplates[idx]);
      });
    });
  }
}

function openSavePrompt() {
  const s = currentSearchState(state, els);
  if (!s.table || (!s.field_name && !s.advanced && !s.conditions.length)) {
    showStatus('Build a search first, then save it.', 'error', 2500); return;
  }
  els.savePrompt.style.display     = 'flex';
  els.saveTemplateBtn.style.display = 'none';
  els.saveNameInput.value = chipLabel(s).slice(0, 30);
  els.saveNameInput.focus();
  els.saveNameInput.select();
}

function closeSavePrompt() {
  els.savePrompt.style.display     = 'none';
  els.saveTemplateBtn.style.display = '';
  els.saveNameInput.value = '';
}

function confirmSave() {
  const name = els.saveNameInput.value.trim();
  if (!name) { els.saveNameInput.focus(); return; }
  const s      = currentSearchState(state, els);
  const newTpl = { name, ...s };
  const ei     = state.savedTemplates.findIndex((t) => t.name === name);
  if (ei >= 0) state.savedTemplates[ei] = newTpl;
  else state.savedTemplates.unshift(newTpl);
  persistSaved(state);
  renderTemplates();
  closeSavePrompt();
  showStatus(`Saved "${name}"`, 'success', 1800);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Export / Import templates
// ─────────────────────────────────────────────────────────────────────────────
els.exportTemplatesBtn.addEventListener('click', () => {
  if (!state.savedTemplates.length) {
    showStatus('No saved templates to export.', 'warn', 2000); return;
  }
  const json = exportTemplates(state);
  navigator.clipboard.writeText(json).then(() => {
    showStatus(`Copied ${state.savedTemplates.length} template(s) to clipboard.`, 'success', 2500);
  }).catch(() => {
    // Fallback: show in textarea
    els.importModal.style.display = 'block';
    els.importJson.value = json;
    els.importJson.select();
  });
});

els.importTemplatesBtn.addEventListener('click', () => {
  els.importModal.style.display = els.importModal.style.display === 'none' ? 'block' : 'none';
  if (els.importModal.style.display === 'block') {
    els.importJson.value = '';
    els.importJson.focus();
  }
});

els.cancelImportBtn.addEventListener('click', () => {
  els.importModal.style.display = 'none';
  els.importJson.value = '';
});

els.confirmImportBtn.addEventListener('click', () => {
  const result = importTemplates(state, els.importJson.value);
  if (!result.ok) {
    showStatus(`Import failed: ${result.error}`, 'error', 3500); return;
  }
  renderTemplates();
  els.importModal.style.display = 'none';
  els.importJson.value = '';
  showStatus(`Imported ${result.added} new template(s).`, 'success', 2500);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Field loading helpers
// ─────────────────────────────────────────────────────────────────────────────
function loadFieldsForTable(tableName, onDone) {
  fetchFields(tableName, state, els, {
    onLoading: (loading) => {
      els.fieldLoading.style.display = loading ? 'inline' : 'none';
      if (loading && els.fieldDropdown.classList.contains('open')) renderDropdown([]);
    },
    onFields: (fields) => {
      if (els.fieldDropdown.classList.contains('open')) filterDropdown(els.fieldInput.value);
      if (onDone) onDone(fields);
    },
    onError: (msg, type) => showStatus(msg, type, 3500),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main actions
// ─────────────────────────────────────────────────────────────────────────────
// FIX: defined as const before event listeners (was a hoisted function declaration)
const clearAll = () => {
  // FIX: use selectedIndex = 0 instead of value = '' (value='' is fragile)
  els.tableSelect.selectedIndex = 0;
  els.customTableGroup.style.display = 'none';
  els.customTableInput.value = '';
  state.selectedField = null;
  els.fieldInput.value = '';
  els.fieldClear.classList.remove('visible');
  state.fields = [];
  state.conditions = [];
  renderConditions();
  els.operatorSelect.selectedIndex = 0;
  els.valueInput.disabled = false;
  els.valueInput.value = '';
  els.advancedQuery.value = '';
  els.refResolverGroup.style.display = 'none';
  els.refNameInput.value = '';
  els.refResults.style.display = 'none';
  setJoinToggle('AND');
  updatePreview();
  saveState(state, els);
  showStatus('Cleared.', 'info', 1200);
};

function doSearch() {
  const table = getTable(els);
  if (!table) { showStatus('Select a table first.', 'error'); return; }
  if (!state.instanceUrl) { showStatus('No SN instance — open a SN tab first.', 'error', 3500); return; }
  const query = buildQuery(state, els);
  recordRecentSearch(state, els);
  renderTemplates();
  chrome.runtime.sendMessage({ type: 'OPEN_URL', url: buildUrl(state.instanceUrl, table, query), newTab: false });
  showStatus('Opening…', 'success', 1200);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Event listeners
// ─────────────────────────────────────────────────────────────────────────────

// Field keyboard navigation
els.fieldInput.addEventListener('keydown', (e) => {
  const items = els.fieldDropdown.querySelectorAll('.dropdown-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    state.dropdownKeyIndex = Math.min(state.dropdownKeyIndex + 1, items.length - 1);
    updateKbFocus(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    state.dropdownKeyIndex = Math.max(state.dropdownKeyIndex - 1, -1);
    updateKbFocus(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (state.dropdownKeyIndex >= 0 && items[state.dropdownKeyIndex]) {
      const it = items[state.dropdownKeyIndex];
      selectField(it.dataset.name, it.dataset.label);
    } else {
      closeDropdown();
      doSearch();
    }
  } else if (e.key === 'Escape') {
    closeDropdown();
  } else if (e.key === 'Tab') {
    if (state.dropdownKeyIndex >= 0 && items[state.dropdownKeyIndex]) {
      e.preventDefault();
      const it = items[state.dropdownKeyIndex];
      selectField(it.dataset.name, it.dataset.label);
    } else {
      closeDropdown();
    }
  }
});

// Table select
els.tableSelect.addEventListener('change', () => {
  const v = els.tableSelect.value;
  els.customTableGroup.style.display = v === 'custom' ? 'block' : 'none';
  state.selectedField = null;
  els.fieldInput.value = '';
  els.fieldClear.classList.remove('visible');
  state.fields = [];
  els.refResolverGroup.style.display = 'none';
  if (v !== 'custom') loadFieldsForTable(v);
  updatePreview();
  saveState(state, els);
});

// Custom table input
els.customTableInput.addEventListener('input', debounce(() => {
  const v = els.customTableInput.value.trim();
  if (v.length >= 3) { state.fields = []; loadFieldsForTable(v); }
  updatePreview();
  saveState(state, els);
}, 500));

// Field input
els.fieldInput.addEventListener('focus', () => {
  if (!state.fields.length && state.snTab && !state.fieldsLoading) loadFieldsForTable(getTable(els));
  setTimeout(() => filterDropdown(els.fieldInput.value), 50);
});
els.fieldInput.addEventListener('input', () => {
  state.selectedField = null;
  const v = els.fieldInput.value;
  els.fieldClear.classList.toggle('visible', !!v);
  els.refResolverGroup.style.display = 'none';
  filterDropdown(v);
  updatePreview();
});
els.fieldClear.addEventListener('click', () => {
  state.selectedField = null;
  els.fieldInput.value = '';
  els.fieldClear.classList.remove('visible');
  els.refResolverGroup.style.display = 'none';
  filterDropdown('');
  els.fieldInput.focus();
  updatePreview();
  saveState(state, els);
});
document.addEventListener('mousedown', (e) => {
  if (!els.fieldInput.contains(e.target) && !els.fieldDropdown.contains(e.target)) closeDropdown();
});

// Operator
els.operatorSelect.addEventListener('change', () => {
  els.valueInput.disabled = NO_VAL_OPS.has(els.operatorSelect.value);
  if (els.valueInput.disabled) els.valueInput.value = '';
  updatePreview();
  saveState(state, els);
});

// Value — FIX: debounce the save, not instant write per keystroke
els.valueInput.addEventListener('input', () => { updatePreview(); debouncedSave(); });
els.valueInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleAddCondition(); }
  else if (e.key === 'Enter')                         { e.preventDefault(); doSearch(); }
});

// Advanced — FIX: debounce the save
els.advancedQuery.addEventListener('input', () => { updatePreview(); debouncedSave(); });
els.advancedQuery.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSearch(); }
});
els.clearAdvBtn.addEventListener('click', () => {
  els.advancedQuery.value = '';
  updatePreview();
  saveState(state, els);
});

// Action buttons
els.searchBtn.addEventListener('click', doSearch);
els.clearAllBtn.addEventListener('click', clearAll);

// Template controls
els.clearRecentBtn.addEventListener('click', () => {
  // Double-click confirm pattern (replaces window.confirm)
  if (els.clearRecentBtn.classList.contains('armed')) {
    state.recentSearches = [];
    persistRecent(state);
    renderTemplates();
    els.clearRecentBtn.classList.remove('armed');
  } else {
    els.clearRecentBtn.classList.add('armed');
    const origText = els.clearRecentBtn.textContent;
    els.clearRecentBtn.textContent = 'sure?';
    setTimeout(() => {
      els.clearRecentBtn.classList.remove('armed');
      els.clearRecentBtn.textContent = origText;
    }, 2000);
  }
});
els.saveTemplateBtn.addEventListener('click', openSavePrompt);
els.cancelSaveBtn.addEventListener('click', closeSavePrompt);
els.confirmSaveBtn.addEventListener('click', confirmSave);
els.saveNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  { e.preventDefault(); confirmSave(); }
  if (e.key === 'Escape') { e.preventDefault(); closeSavePrompt(); }
});

// Global Enter on body
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement === document.body) doSearch();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
  await loadTemplates(state);
  renderTemplates();

  // FIX: wrapped in error boundary (restoreState itself is also wrapped now)
  try {
    await restoreState(state, els, '', () => updatePreview());
  } catch (e) {
    console.warn('[SNPowerSearch] init restoreState failed:', e);
    updatePreview();
  }

  await detectInstance(state, els, {
    onOnline: (name, url, tab) => {
      els.instanceDot.classList.remove('offline');
      els.instanceName.textContent    = name;
      els.instanceBadge.title         = url;
      els.warningBanner.style.display = 'none';

      // Feature: auto-detect table from SN tab URL (only if nothing restored)
      if (!getTable(els) && tab) {
        const detected = getTableFromUrl(tab.url);
        if (detected) {
          const opt = [...els.tableSelect.options].find((o) => o.value === detected);
          if (opt) {
            els.tableSelect.value = detected;
          } else {
            els.tableSelect.value = 'custom';
            els.customTableGroup.style.display = 'block';
            els.customTableInput.value = detected;
          }
          updatePreview();
          showStatus(`Table auto-detected: ${detected}`, 'info', 2000);
        }
      }
    },
    onCached: (name) => {
      els.instanceName.textContent = `${name} (cached)`;
    },
    onOffline: () => {
      els.instanceDot.classList.add('offline');
      els.warningBanner.style.display = 'flex';
    },
  });

  if (state.snTab) await loadFieldsForTable(getTable(els));
  setTimeout(() => els.fieldInput.focus(), 120);
}

init();
