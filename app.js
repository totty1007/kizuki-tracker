(() => {
  'use strict';

  const STORES = ['成城学園前', 'イオン新浦安', '蒲田', '町田', '旗の台', '京急蒲田', '金沢文庫', 'NC新浦安', 'その他', '全体'];

  // ---------- IndexedDB storage (replaces window.storage from Claude Artifacts) ----------
  const idbStorage = (() => {
    const DB_NAME = 'kizuki-moushiokuri-db';
    const STORE_NAME = 'kv';
    let dbPromise = null;
    let available = typeof indexedDB !== 'undefined';

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE_NAME)) {
            req.result.createObjectStore(STORE_NAME);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }

    async function get(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const r = tx.objectStore(STORE_NAME).get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }

    async function set(key, value) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    return { get, set, get available() { return available; }, markUnavailable() { available = false; } };
  })();

  // ---------- App state ----------
  let entries = [];
  let storageAvailable = true;

  // ---------- Utilities ----------
  function genId() {
    return 'e' + Date.now() + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatDateTime(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function formatDateOnly(d) {
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  function formatYYYYMMDD(d) {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  }

  let toastTimer = null;
  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  // ---------- Persistence ----------
  async function loadEntries() {
    if (!idbStorage.available) {
      storageAvailable = false;
      entries = [];
      return;
    }
    try {
      const stored = await idbStorage.get('entries');
      entries = Array.isArray(stored) ? stored : [];
    } catch (e) {
      storageAvailable = false;
      idbStorage.markUnavailable();
      entries = [];
    }
    updateWarningBanner();
  }

  async function saveEntries() {
    if (!idbStorage.available) {
      storageAvailable = false;
      updateWarningBanner();
      return;
    }
    try {
      await idbStorage.set('entries', entries);
    } catch (e) {
      storageAvailable = false;
      idbStorage.markUnavailable();
      updateWarningBanner();
    }
  }

  function updateWarningBanner() {
    document.getElementById('warningBanner').style.display = storageAvailable ? 'none' : 'block';
  }

  // ---------- Tab navigation ----------
  function initTabs() {
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tabpanel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'list') renderList();
        if (btn.dataset.tab === 'backup') renderTotalCount();
      });
    });
  }

  // ---------- Input tab ----------
  let selectedType = '気付き';
  let selectedStatus = '未対応';
  let selectedImportance = '通常';

  function initStoreSelects() {
    const storeSelect = document.getElementById('storeSelect');
    STORES.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      storeSelect.appendChild(opt);
    });

    const filterStore = document.getElementById('filterStore');
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = '店舗:すべて';
    filterStore.appendChild(allOpt);
    STORES.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      filterStore.appendChild(opt);
    });
  }

  function initSegments() {
    const typeSegment = document.getElementById('typeSegment');
    typeSegment.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      selectedType = btn.dataset.value;
      [...typeSegment.children].forEach(b => b.classList.toggle('selected', b === btn));
      document.getElementById('statusField').style.display = selectedType === '申し送り' ? 'block' : 'none';
    });

    const statusSegment = document.getElementById('statusSegment');
    statusSegment.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      selectedStatus = btn.dataset.value;
      [...statusSegment.children].forEach(b => b.classList.toggle('selected', b === btn));
    });

    const importanceSegment = document.getElementById('importanceSegment');
    importanceSegment.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      selectedImportance = btn.dataset.value;
      [...importanceSegment.children].forEach(b => b.classList.toggle('selected', b === btn));
    });
  }

  async function handleSubmit() {
    const contentInput = document.getElementById('contentInput');
    const content = contentInput.value.trim();
    if (!content) {
      showToast('内容を入力してください');
      return;
    }
    const entry = {
      id: genId(),
      datetime: new Date().toISOString(),
      store: document.getElementById('storeSelect').value,
      type: selectedType,
      importance: selectedImportance,
      status: selectedType === '申し送り' ? selectedStatus : '',
      content,
    };
    entries.unshift(entry);
    await saveEntries();
    contentInput.value = '';
    showToast('記録しました');
  }

  // ---------- List tab ----------
  function renderList() {
    const storeFilter = document.getElementById('filterStore').value;
    const typeFilter = document.getElementById('filterType').value;
    const statusFilter = document.getElementById('filterStatus').value;

    const filtered = entries.filter(e => {
      if (storeFilter && e.store !== storeFilter) return false;
      if (typeFilter && e.type !== typeFilter) return false;
      if (statusFilter && e.status !== statusFilter) return false;
      return true;
    });

    const listEl = document.getElementById('entryList');
    listEl.innerHTML = '';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '該当する記録がありません';
      listEl.appendChild(empty);
      return;
    }

    filtered.forEach(entry => {
      const card = document.createElement('div');
      card.className = 'entry-card';

      const chips = document.createElement('div');
      chips.className = 'chips';

      const storeChip = document.createElement('span');
      storeChip.className = 'chip store';
      storeChip.textContent = entry.store;
      chips.appendChild(storeChip);

      const typeChip = document.createElement('span');
      typeChip.className = 'chip type-' + entry.type;
      typeChip.textContent = entry.type;
      chips.appendChild(typeChip);

      const impChip = document.createElement('span');
      impChip.className = 'chip imp-' + entry.importance;
      impChip.textContent = entry.importance;
      chips.appendChild(impChip);

      if (entry.type === '申し送り' && entry.status) {
        const statusChip = document.createElement('span');
        statusChip.className = 'chip status-' + entry.status;
        statusChip.textContent = entry.status;
        chips.appendChild(statusChip);
      }

      card.appendChild(chips);

      const contentEl = document.createElement('div');
      contentEl.className = 'entry-content';
      contentEl.textContent = entry.content;
      card.appendChild(contentEl);

      const footer = document.createElement('div');
      footer.className = 'entry-footer';

      const dateEl = document.createElement('span');
      dateEl.textContent = formatDateTime(entry.datetime);
      footer.appendChild(dateEl);

      const delBtn = document.createElement('button');
      delBtn.className = 'delete-btn';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', () => handleDelete(entry.id));
      footer.appendChild(delBtn);

      card.appendChild(footer);
      listEl.appendChild(card);
    });
  }

  async function handleDelete(id) {
    if (!confirm('この記録を削除しますか?')) return;
    entries = entries.filter(e => e.id !== id);
    await saveEntries();
    renderList();
  }

  function initListFilters() {
    ['filterStore', 'filterType', 'filterStatus'].forEach(id => {
      document.getElementById(id).addEventListener('change', renderList);
    });
  }

  // ---------- Export (Excel) ----------
  function buildWorkbook(rangeStart, rangeEnd) {
    const target = entries.filter(e => {
      const t = new Date(e.datetime).getTime();
      return t >= rangeStart.getTime() && t <= rangeEnd.getTime();
    });

    if (target.length === 0) return null;

    const storeOrder = (s) => {
      const idx = STORES.indexOf(s);
      return idx === -1 ? STORES.length : idx;
    };
    target.sort((a, b) => {
      const so = storeOrder(a.store) - storeOrder(b.store);
      if (so !== 0) return so;
      return new Date(a.datetime).getTime() - new Date(b.datetime).getTime();
    });

    // --- サマリーシート ---
    const summaryMap = new Map();
    STORES.forEach(s => summaryMap.set(s, { store: s, kizuki: 0, moushiokuri: 0, kinkyu: 0, mitaiou: 0 }));
    target.forEach(e => {
      const row = summaryMap.get(e.store);
      if (!row) return;
      if (e.type === '気付き') row.kizuki++;
      if (e.type === '申し送り') row.moushiokuri++;
      if (e.importance === '緊急') row.kinkyu++;
      if (e.type === '申し送り' && e.status === '未対応') row.mitaiou++;
    });

    const summaryRows = STORES.map(s => summaryMap.get(s)).filter(r => r.kizuki + r.moushiokuri > 0);
    const totalRow = summaryRows.reduce((acc, r) => ({
      store: '合計',
      kizuki: acc.kizuki + r.kizuki,
      moushiokuri: acc.moushiokuri + r.moushiokuri,
      kinkyu: acc.kinkyu + r.kinkyu,
      mitaiou: acc.mitaiou + r.mitaiou,
    }), { store: '合計', kizuki: 0, moushiokuri: 0, kinkyu: 0, mitaiou: 0 });

    const summaryAOA = [
      ['店舗', '気付き件数', '申し送り件数', 'うち緊急件数', 'うち未対応(申し送り)件数'],
      ...summaryRows.map(r => [r.store, r.kizuki, r.moushiokuri, r.kinkyu, r.mitaiou]),
      [totalRow.store, totalRow.kizuki, totalRow.moushiokuri, totalRow.kinkyu, totalRow.mitaiou],
      [],
      ['対象期間', `${formatDateOnly(rangeStart)} 〜 ${formatDateOnly(rangeEnd)}`],
      ['出力日時', formatDateTime(new Date().toISOString())],
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryAOA);
    summarySheet['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 20 }];

    // --- 全データシート ---
    const allDataAOA = [
      ['日時', '店舗', '種別', '重要度', '対応状況', '内容'],
      ...target.map(e => [
        formatDateTime(e.datetime),
        e.store,
        e.type,
        e.importance,
        e.status || '-',
        e.content,
      ]),
    ];
    const allDataSheet = XLSX.utils.aoa_to_sheet(allDataAOA);
    allDataSheet['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 50 }];

    // --- 未対応の申し送りシート ---
    const pending = target.filter(e => e.type === '申し送り' && e.status === '未対応');
    const pendingAOA = pending.length > 0
      ? [
        ['日時', '店舗', '重要度', '内容'],
        ...pending.map(e => [formatDateTime(e.datetime), e.store, e.importance, e.content]),
      ]
      : [['未対応の申し送りはありません']];
    const pendingSheet = XLSX.utils.aoa_to_sheet(pendingAOA);
    pendingSheet['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 10 }, { wch: 50 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, summarySheet, 'サマリー');
    XLSX.utils.book_append_sheet(wb, allDataSheet, '全データ');
    XLSX.utils.book_append_sheet(wb, pendingSheet, '未対応の申し送り');
    return wb;
  }

  async function exportExcel(rangeStart, rangeEnd, filePrefix) {
    const wb = buildWorkbook(rangeStart, rangeEnd);
    if (!wb) {
      showToast('この期間のデータがありません');
      return;
    }
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const filename = `${filePrefix}まとめ_${formatYYYYMMDD(rangeStart)}-${formatYYYYMMDD(rangeEnd)}.xlsx`;
    await shareOrDownload(blob, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  function initExportTab() {
    document.getElementById('weeklyExportBtn').addEventListener('click', () => {
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      const start = new Date();
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      exportExcel(start, end, '週次');
    });

    document.getElementById('rangeExportBtn').addEventListener('click', () => {
      const startVal = document.getElementById('rangeStart').value;
      const endVal = document.getElementById('rangeEnd').value;
      if (!startVal || !endVal) {
        showToast('開始日・終了日を指定してください');
        return;
      }
      const start = new Date(startVal + 'T00:00:00');
      const end = new Date(endVal + 'T23:59:59');
      exportExcel(start, end, '期間');
    });
  }

  // ---------- Backup tab (CSV) ----------
  function csvEscape(value) {
    const s = value == null ? '' : String(value);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function buildCsv() {
    const header = ['id', 'datetime', 'store', 'type', 'importance', 'status', 'content'];
    const lines = [header.join(',')];
    entries.forEach(e => {
      lines.push([e.id, e.datetime, e.store, e.type, e.importance, e.status, e.content].map(csvEscape).join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function parseCsv(text) {
    // Strip BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const len = text.length;
    while (i < len) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      } else {
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === ',') { row.push(field); field = ''; i++; continue; }
        if (c === '\r') { i++; continue; }
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
        field += c; i++; continue;
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter(r => !(r.length === 1 && r[0] === ''));
  }

  async function handleCsvExport() {
    if (entries.length === 0) {
      showToast('データがありません');
      return;
    }
    const csv = buildCsv();
    const blob = new Blob([csv], { type: 'text/csv' });
    const filename = `気付き申し送り_backup_${formatYYYYMMDD(new Date())}.csv`;
    await shareOrDownload(blob, filename, 'text/csv');
  }

  async function handleCsvImport(file) {
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length <= 1) {
      showToast('復元できるデータがありませんでした');
      return;
    }
    const header = rows[0];
    const idIdx = header.indexOf('id');
    const dtIdx = header.indexOf('datetime');
    const storeIdx = header.indexOf('store');
    const typeIdx = header.indexOf('type');
    const impIdx = header.indexOf('importance');
    const statusIdx = header.indexOf('status');
    const contentIdx = header.indexOf('content');

    const existingIds = new Set(entries.map(e => e.id));
    let restored = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const id = r[idIdx];
      if (!id || existingIds.has(id)) continue;
      entries.push({
        id,
        datetime: r[dtIdx] || new Date().toISOString(),
        store: r[storeIdx] || '',
        type: r[typeIdx] || '',
        importance: r[impIdx] || '通常',
        status: r[statusIdx] || '',
        content: r[contentIdx] || '',
      });
      existingIds.add(id);
      restored++;
    }
    if (restored > 0) {
      await saveEntries();
    }
    renderTotalCount();
    showToast(`${restored}件を復元しました`);
  }

  function renderTotalCount() {
    document.getElementById('totalCount').textContent = `現在の総件数: ${entries.length}件`;
  }

  function initBackupTab() {
    document.getElementById('csvExportBtn').addEventListener('click', handleCsvExport);
    document.getElementById('csvImportInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await handleCsvImport(file);
      e.target.value = '';
    });
  }

  // ---------- Common save/share ----------
  async function shareOrDownload(blob, filename, mimeType) {
    try {
      if (navigator.share && navigator.canShare) {
        const file = new File([blob], filename, { type: mimeType });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          showToast('共有シートを開きました');
          return;
        }
      }
    } catch (err) {
      // AbortError = user cancelled the share sheet; treat as no-op, not a failure.
      if (err && err.name === 'AbortError') return;
    }

    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (err) {
      showToast('保存に失敗しました。ブラウザで開いてお試しください');
    }
  }

  // ---------- Init ----------
  async function init() {
    initTabs();
    initStoreSelects();
    initSegments();
    initListFilters();
    initExportTab();
    initBackupTab();

    document.getElementById('submitBtn').addEventListener('click', handleSubmit);

    await loadEntries();
    renderList();
    renderTotalCount();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
