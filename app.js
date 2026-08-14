(() => {
  'use strict';

  // 工場出荷時のデフォルト構成。エリア編成が変わっても書き換えず、
  // 設定タブの「初期設定に戻す」の復元先として残す。
  const DEFAULT_AREA_ORDER = ['第1エリア', '第2エリア', '第3エリア', '第4エリア', '第5エリア', '第6エリア', '九州北エリア', '九州南エリア'];
  const DEFAULT_AREA_STORES = {
    '第1エリア': ['葛西駅前', '妙典駅前', 'IY木場', '船堀TB', '門前仲町', 'アリオ葛西', '南砂町スナモ', 'イオン八千代緑が丘'],
    '第2エリア': ['瑞江', '本八幡', '平井', 'IY四街道', 'ユニモちはら台', 'イオンマリンピア', 'アリオ蘇我', 'アリオ北砂'],
    '第3エリア': ['曳舟', '綾瀬', 'FP八潮', 'AM新鎌ケ谷', 'イオン新松戸', '北千住', '松戸西口', 'イオン水戸内原'],
    '第4エリア': ['あさか台', 'PW東松山', 'ときわ台', 'LG川口', 'ステラタウン', 'アリオ鷲宮', 'イオン上尾', '新所沢'],
    '第5エリア': ['西国分寺', '保谷', 'ひばりヶ丘', '清瀬', '千歳烏山', '入間', '調布', '東久留米', 'FP若葉台'],
    '第6エリア': ['成城学園前', 'イオン新浦安', '蒲田', '町田', '旗の台', '京急蒲田', '金沢文庫', 'NC新浦安'],
    '九州北エリア': ['みらい長崎', 'イオン佐賀大和', 'イオン三光', 'おのだサンパーク', 'サンリブ小倉'],
    '九州南エリア': ['イオン都城', 'イオン宮崎', 'イオン延岡SC', '宮交シティ'],
  };
  const DEFAULT_AREA = '第6エリア';

  // 実際に使用するエリア構成(設定タブで編集可能・IndexedDBに保存)。
  // 初期値はデフォルト構成のコピーで、loadAreaConfig()で保存済みの内容に置き換わる。
  let AREA_ORDER = [...DEFAULT_AREA_ORDER];
  let AREA_STORES = JSON.parse(JSON.stringify(DEFAULT_AREA_STORES));
  let currentArea = DEFAULT_AREA;
  let STORES = [];

  function storesForArea(area) {
    const list = AREA_STORES[area] || AREA_STORES[DEFAULT_AREA] || AREA_STORES[AREA_ORDER[0]] || [];
    return [...list, 'その他', '全体'];
  }

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

  // ---------- Area/store configuration persistence ----------
  // 気付き・申し送りの記録データ(entriesキー)とは完全に別のキーに保存する。
  // エリア構成を編集・リセットしても記録データには一切影響しない。
  const AREA_CONFIG_KEY = 'areaConfig';

  function isValidAreaConfig(cfg) {
    return !!cfg && Array.isArray(cfg.order) && cfg.order.length > 0 && cfg.stores && typeof cfg.stores === 'object'
      && cfg.order.every(a => typeof a === 'string' && a.trim() !== '' && Array.isArray(cfg.stores[a]));
  }

  async function loadAreaConfig() {
    let cfg = null;
    try {
      cfg = await idbStorage.get(AREA_CONFIG_KEY);
    } catch (e) {
      cfg = null;
    }
    if (isValidAreaConfig(cfg)) {
      AREA_ORDER = [...cfg.order];
      AREA_STORES = {};
      cfg.order.forEach(a => { AREA_STORES[a] = [...cfg.stores[a]]; });
    } else {
      // 初回起動時など未保存の場合はデフォルト構成を保存しておく(移行)
      AREA_ORDER = [...DEFAULT_AREA_ORDER];
      AREA_STORES = JSON.parse(JSON.stringify(DEFAULT_AREA_STORES));
      await saveAreaConfig();
    }
  }

  async function saveAreaConfig() {
    await idbStorage.set(AREA_CONFIG_KEY, {
      order: [...AREA_ORDER],
      stores: JSON.parse(JSON.stringify(AREA_STORES)),
    });
  }

  // ---------- Google Drive direct upload (optional; falls back to shareOrDownload) ----------
  const driveSync = (() => {
    const CLIENT_ID = '614632344728-nub88bg4gt5ur7phspcqfraprrdgn0ck.apps.googleusercontent.com';
    const API_KEY = 'AIzaSyCbJd8tJxRPRNMDla_2SGEzHArOyerap0M';
    const SCOPE = 'https://www.googleapis.com/auth/drive.file';

    let tokenClient = null;
    let accessToken = null;
    let tokenExpiresAt = 0;
    let gisReady = false;
    let gapiReady = false;

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('failed to load ' + src));
        document.head.appendChild(s);
      });
    }

    async function ensureGis() {
      if (gisReady) return;
      if (!(window.google && window.google.accounts && window.google.accounts.oauth2)) {
        await loadScript('https://accounts.google.com/gsi/client');
      }
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: () => {},
      });
      gisReady = true;
    }

    async function ensureGapiPicker() {
      if (gapiReady) return;
      if (!window.gapi) {
        await loadScript('https://apis.google.com/js/api.js');
      }
      await new Promise((resolve) => window.gapi.load('picker', resolve));
      gapiReady = true;
    }

    function requestToken(interactive) {
      return new Promise((resolve, reject) => {
        tokenClient.callback = (resp) => {
          if (resp.error) { reject(resp); return; }
          accessToken = resp.access_token;
          tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
          resolve(accessToken);
        };
        tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      });
    }

    async function getToken(interactive) {
      await ensureGis();
      if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
      return requestToken(interactive);
    }

    async function pickFolder() {
      await ensureGapiPicker();
      const token = await getToken(true);
      return new Promise((resolve) => {
        const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true)
          .setMimeTypes('application/vnd.google-apps.folder');
        const picker = new window.google.picker.PickerBuilder()
          .addView(view)
          .setOAuthToken(token)
          .setDeveloperKey(API_KEY)
          .setCallback((data) => {
            if (data.action === window.google.picker.Action.PICKED) {
              const doc = data.docs[0];
              resolve({ id: doc.id, name: doc.name });
            } else if (data.action === window.google.picker.Action.CANCEL) {
              resolve(null);
            }
          })
          .build();
        picker.setVisible(true);
      });
    }

    async function connect() {
      const folder = await pickFolder();
      if (!folder) return null;
      await idbStorage.set('driveFolderId', folder.id);
      await idbStorage.set('driveFolderName', folder.name);
      return folder;
    }

    async function disconnect() {
      accessToken = null;
      tokenExpiresAt = 0;
      await idbStorage.set('driveFolderId', null);
      await idbStorage.set('driveFolderName', null);
    }

    async function getFolderInfo() {
      const id = await idbStorage.get('driveFolderId');
      const name = await idbStorage.get('driveFolderName');
      return id ? { id, name } : null;
    }

    function arrayBufferToBase64(buffer) {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    }

    async function uploadWithToken(token, folderId, blob, filename, mimeType) {
      const metadata = { name: filename, parents: [folderId] };
      const boundary = 'kizuki_tracker_boundary_314159265358979';
      const base64Data = arrayBufferToBase64(await blob.arrayBuffer());
      const body =
        `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        `--${boundary}\r\n` +
        `Content-Type: ${mimeType}\r\n` +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        base64Data + '\r\n' +
        `--${boundary}--`;

      return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
    }

    async function upload(blob, filename, mimeType) {
      const folder = await getFolderInfo();
      if (!folder) return { ok: false, reason: 'not-configured' };

      let token;
      try {
        token = await getToken(false);
      } catch (e) {
        return { ok: false, reason: 'auth-failed' };
      }

      try {
        let res = await uploadWithToken(token, folder.id, blob, filename, mimeType);
        if (!res.ok && res.status === 401) {
          token = await getToken(true);
          res = await uploadWithToken(token, folder.id, blob, filename, mimeType);
        }
        return res.ok ? { ok: true, folderName: folder.name } : { ok: false, reason: 'upload-failed' };
      } catch (e) {
        return { ok: false, reason: 'network-error' };
      }
    }

    return { connect, disconnect, getFolderInfo, upload };
  })();

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
        if (btn.dataset.tab === 'settings') renderSettingsTab();
      });
    });
  }

  // ---------- Input tab ----------
  let selectedType = '気付き';
  let selectedStatus = '未対応';
  let selectedImportance = '通常';

  function rebuildStoreSelects() {
    const storeSelect = document.getElementById('storeSelect');
    storeSelect.innerHTML = '';
    STORES.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      storeSelect.appendChild(opt);
    });

    const filterStore = document.getElementById('filterStore');
    filterStore.innerHTML = '';
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

  function populateAreaSelectOptions() {
    const areaSelect = document.getElementById('areaSelect');
    areaSelect.innerHTML = '';
    AREA_ORDER.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      areaSelect.appendChild(opt);
    });
    areaSelect.value = currentArea;
  }

  async function initAreaSelect() {
    const areaSelect = document.getElementById('areaSelect');

    const saved = await idbStorage.get('currentArea');
    currentArea = AREA_ORDER.includes(saved) ? saved : DEFAULT_AREA;
    if (!AREA_ORDER.includes(currentArea)) currentArea = AREA_ORDER[0] || DEFAULT_AREA;

    populateAreaSelectOptions();
    STORES = storesForArea(currentArea);

    areaSelect.addEventListener('change', async () => {
      currentArea = areaSelect.value;
      STORES = storesForArea(currentArea);
      await idbStorage.set('currentArea', currentArea);
      rebuildStoreSelects();
      renderList();
      showToast(`担当エリアを「${currentArea}」に変更しました`);
    });
  }

  // 設定タブでエリア構成を保存した後に呼ぶ: 現在選択中のエリアが
  // 削除/改名されていればフォールバックし、関連UIを一通り作り直す。
  // 戻り値: フォールバックが発生した場合は切替後のエリア名、なければnull。
  async function applyAreaConfigChange() {
    let switchedTo = null;
    if (!AREA_ORDER.includes(currentArea)) {
      currentArea = AREA_ORDER.includes(DEFAULT_AREA) ? DEFAULT_AREA : (AREA_ORDER[0] || DEFAULT_AREA);
      await idbStorage.set('currentArea', currentArea);
      switchedTo = currentArea;
    }
    populateAreaSelectOptions();
    STORES = storesForArea(currentArea);
    rebuildStoreSelects();
    renderList();
    return switchedTo;
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
      if (a.store !== b.store) return a.store < b.store ? -1 : 1;
      return new Date(a.datetime).getTime() - new Date(b.datetime).getTime();
    });

    // --- サマリーシート ---
    // エリア切替後は過去の担当エリアの店舗名がSTORESに含まれないため、
    // 実データに登場する店舗名も必ずMapに含めて集計漏れを防ぐ
    const summaryMap = new Map();
    STORES.forEach(s => summaryMap.set(s, { store: s, kizuki: 0, moushiokuri: 0, kinkyu: 0, mitaiou: 0 }));
    target.forEach(e => {
      if (!summaryMap.has(e.store)) {
        summaryMap.set(e.store, { store: e.store, kizuki: 0, moushiokuri: 0, kinkyu: 0, mitaiou: 0 });
      }
      const row = summaryMap.get(e.store);
      if (e.type === '気付き') row.kizuki++;
      if (e.type === '申し送り') row.moushiokuri++;
      if (e.importance === '緊急') row.kinkyu++;
      if (e.type === '申し送り' && e.status === '未対応') row.mitaiou++;
    });

    const orderedStoreNames = [...STORES, ...[...summaryMap.keys()].filter(s => !STORES.includes(s))];
    const summaryRows = orderedStoreNames.map(s => summaryMap.get(s)).filter(r => r.kizuki + r.moushiokuri > 0);
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
    await saveExportFile(blob, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
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
    await saveExportFile(blob, filename, 'text/csv');
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

  // ---------- Save entry point: try Drive auto-upload first, then fall back to share/download ----------
  async function saveExportFile(blob, filename, mimeType) {
    const result = await driveSync.upload(blob, filename, mimeType);
    if (result.ok) {
      showToast(`「${result.folderName}」に自動保存しました`);
      return;
    }
    await shareOrDownload(blob, filename, mimeType);
  }

  async function refreshDriveStatus() {
    const statusEl = document.getElementById('driveStatus');
    const connectBtn = document.getElementById('driveConnectBtn');
    const disconnectBtn = document.getElementById('driveDisconnectBtn');
    const folder = await driveSync.getFolderInfo();
    if (folder) {
      statusEl.textContent = `連携中: 「${folder.name}」フォルダへ自動保存されます`;
      connectBtn.textContent = '保存先フォルダを変更する';
      disconnectBtn.style.display = 'block';
    } else {
      statusEl.textContent = '未連携です。連携すると、Excel/CSV出力時に選んだフォルダへ自動アップロードされます。';
      connectBtn.textContent = 'Googleドライブと連携する(保存先フォルダを選択)';
      disconnectBtn.style.display = 'none';
    }
  }

  function initDriveTab() {
    document.getElementById('driveConnectBtn').addEventListener('click', async () => {
      try {
        const folder = await driveSync.connect();
        if (folder) showToast(`「${folder.name}」と連携しました`);
      } catch (e) {
        showToast('連携に失敗しました。もう一度お試しください');
      }
      await refreshDriveStatus();
    });
    document.getElementById('driveDisconnectBtn').addEventListener('click', async () => {
      await driveSync.disconnect();
      showToast('連携を解除しました');
      await refreshDriveStatus();
    });
  }

  // ---------- Settings tab (エリア/店舗の手動編集) ----------
  // 編集中の内容は保存ボタンを押すまで settingsDraft 上でのみ扱い、
  // AREA_ORDER/AREA_STORES(実際に使われる構成)には反映しない。
  // 記録済みのentries(気付き・申し送り)はこの画面からは一切触らない。
  //
  // settingsDraft は [{ name, stores: [...] }, ...] という配列。
  // エリア名の文字列をキーにせず「配列内の位置」で操作することで、
  // エリア名を編集中(未保存)でも店舗の追加・削除ボタンが正しい対象に効くようにする。
  let settingsDraft = null;

  function draftFromLive() {
    return AREA_ORDER.map(a => ({ name: a, stores: [...(AREA_STORES[a] || [])] }));
  }

  function renderSettingsTab() {
    settingsDraft = draftFromLive();
    renderAreaCards();
  }

  // ボタン操作の直前に必ず呼び、その時点でDOMに入力されている内容を
  // settingsDraftへ丸ごと反映してから配列を操作する。
  function syncDraftFromDom() {
    if (!settingsDraft) return;
    const cards = document.querySelectorAll('#areaCardList .area-card');
    settingsDraft = [...cards].map(card => {
      const name = card.querySelector('.area-name-input').value.trim() || '(無名エリア)';
      const stores = [...card.querySelectorAll('.store-name-input')]
        .map(inp => inp.value.trim())
        .filter(s => s !== '');
      return { name, stores };
    });
  }

  function renderAreaCards() {
    const list = document.getElementById('areaCardList');
    list.innerHTML = '';

    if (settingsDraft.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'エリアがありません。「+ エリアを追加」から追加してください';
      list.appendChild(empty);
      return;
    }

    settingsDraft.forEach((areaObj, areaIdx) => {
      const card = document.createElement('div');
      card.className = 'area-card';

      // --- エリア名 + 並び替え/削除 ---
      const header = document.createElement('div');
      header.className = 'area-card-header';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'area-name-input';
      nameInput.value = areaObj.name;
      header.appendChild(nameInput);

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'icon-btn';
      upBtn.textContent = '↑';
      upBtn.disabled = areaIdx === 0;
      upBtn.addEventListener('click', () => {
        syncDraftFromDom();
        if (areaIdx > 0) {
          [settingsDraft[areaIdx - 1], settingsDraft[areaIdx]] = [settingsDraft[areaIdx], settingsDraft[areaIdx - 1]];
        }
        renderAreaCards();
      });
      header.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'icon-btn';
      downBtn.textContent = '↓';
      downBtn.disabled = areaIdx === settingsDraft.length - 1;
      downBtn.addEventListener('click', () => {
        syncDraftFromDom();
        if (areaIdx < settingsDraft.length - 1) {
          [settingsDraft[areaIdx + 1], settingsDraft[areaIdx]] = [settingsDraft[areaIdx], settingsDraft[areaIdx + 1]];
        }
        renderAreaCards();
      });
      header.appendChild(downBtn);

      const delAreaBtn = document.createElement('button');
      delAreaBtn.type = 'button';
      delAreaBtn.className = 'icon-btn danger';
      delAreaBtn.textContent = '削除';
      delAreaBtn.addEventListener('click', () => {
        if (!confirm(`「${areaObj.name}」エリアを削除しますか?(このエリアに含まれる店舗の過去の記録データは削除されません)`)) return;
        syncDraftFromDom();
        settingsDraft.splice(areaIdx, 1);
        renderAreaCards();
      });
      header.appendChild(delAreaBtn);

      card.appendChild(header);

      // --- 店舗一覧(1店舗ずつ追加・削除) ---
      const storesLabel = document.createElement('label');
      storesLabel.className = 'area-stores-label';
      storesLabel.textContent = '店舗';
      card.appendChild(storesLabel);

      const storeRowList = document.createElement('div');
      storeRowList.className = 'store-row-list';

      areaObj.stores.forEach((storeName, storeIdx) => {
        const row = document.createElement('div');
        row.className = 'store-row';

        const storeInput = document.createElement('input');
        storeInput.type = 'text';
        storeInput.className = 'store-name-input';
        storeInput.value = storeName;
        storeInput.placeholder = '店舗名';
        row.appendChild(storeInput);

        const delStoreBtn = document.createElement('button');
        delStoreBtn.type = 'button';
        delStoreBtn.className = 'icon-btn danger small';
        delStoreBtn.textContent = '×';
        delStoreBtn.title = `「${storeName || '(未入力)'}」を削除(閉店時など)`;
        delStoreBtn.addEventListener('click', () => {
          syncDraftFromDom();
          settingsDraft[areaIdx].stores.splice(storeIdx, 1);
          renderAreaCards();
        });
        row.appendChild(delStoreBtn);

        storeRowList.appendChild(row);
      });

      if (areaObj.stores.length === 0) {
        const emptyStores = document.createElement('div');
        emptyStores.className = 'hint';
        emptyStores.textContent = 'まだ店舗がありません。「+ 店舗を追加」から追加してください';
        storeRowList.appendChild(emptyStores);
      }

      card.appendChild(storeRowList);

      const addStoreBtn = document.createElement('button');
      addStoreBtn.type = 'button';
      addStoreBtn.className = 'btn-secondary small';
      addStoreBtn.textContent = '+ 店舗を追加(新店オープン時など)';
      addStoreBtn.addEventListener('click', () => {
        syncDraftFromDom();
        settingsDraft[areaIdx].stores.push('');
        renderAreaCards();
        const cardsNow = document.querySelectorAll('#areaCardList .area-card');
        const inputsNow = cardsNow[areaIdx].querySelectorAll('.store-name-input');
        const lastInput = inputsNow[inputsNow.length - 1];
        if (lastInput) lastInput.focus();
      });
      card.appendChild(addStoreBtn);

      list.appendChild(card);
    });
  }

  function initSettingsTab() {
    document.getElementById('addAreaBtn').addEventListener('click', () => {
      syncDraftFromDom();
      let n = 1;
      let name = '新しいエリア';
      while (settingsDraft.some(a => a.name === name)) { n++; name = `新しいエリア${n}`; }
      settingsDraft.push({ name, stores: [] });
      renderAreaCards();
    });

    document.getElementById('saveAreaConfigBtn').addEventListener('click', async () => {
      syncDraftFromDom();
      const names = settingsDraft.map(a => a.name);
      if (names.length === 0) {
        showToast('エリアを1つ以上登録してください');
        return;
      }
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) {
        showToast(`エリア名「${dup}」が重複しています`);
        return;
      }
      AREA_ORDER = [...names];
      AREA_STORES = {};
      settingsDraft.forEach(a => { AREA_STORES[a.name] = [...a.stores]; });
      await saveAreaConfig();
      const switchedTo = await applyAreaConfigChange();
      renderSettingsTab();
      showToast(switchedTo
        ? `エリア設定を保存しました(担当エリアを「${switchedTo}」に切替)`
        : 'エリア設定を保存しました');
    });

    document.getElementById('resetAreaConfigBtn').addEventListener('click', async () => {
      if (!confirm('エリア設定を初期状態に戻しますか?(記録済みの気付き・申し送りデータは削除されません)')) return;
      AREA_ORDER = [...DEFAULT_AREA_ORDER];
      AREA_STORES = JSON.parse(JSON.stringify(DEFAULT_AREA_STORES));
      await saveAreaConfig();
      const switchedTo = await applyAreaConfigChange();
      renderSettingsTab();
      showToast(switchedTo
        ? `エリア設定を初期状態に戻しました(担当エリアを「${switchedTo}」に切替)`
        : 'エリア設定を初期状態に戻しました');
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
    await loadAreaConfig();
    await initAreaSelect();
    rebuildStoreSelects();
    initSegments();
    initListFilters();
    initExportTab();
    initBackupTab();
    initDriveTab();
    initSettingsTab();

    document.getElementById('submitBtn').addEventListener('click', handleSubmit);

    await loadEntries();
    renderList();
    renderTotalCount();
    await refreshDriveStatus();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
