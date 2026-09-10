(() => {
  const CHANNEL = 'LC_BRIDGE_V240';
  const VERSION = '2.6';
  const STORAGE_UI = 'lc_ui_v190';
  const ROW_HEIGHT = 58;
  const OVERSCAN = 8;
  const PREVIEW_CONCURRENCY = 4;

  const state = {
    accountReady: false,
    bridgeReady: false,
    librarySource: null,
    accountKey: '',
    files: new Map(),
    selected: new Set(),
    query: '',
    typeFilter: 'all',
    cleanTypeFilter: 'all',
    sort: 'newest',
    deletableOnly: false,
    activeTab: 'files',
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    syncing: false,
    syncRequestId: '',
    enriching: false,
    enrichRequestId: '',
    enrichProgress: null,
    syncProgress: null,
    syncCheckpoint: null,
    lastSyncAt: 0,
    deleting: false,
    deleteProgress: null,
    downloading: false,
    downloadProgress: null,
    backupRequestId: '',
    concurrency: 2,
    autoSync: true,
    cutoffDate: '',
    dateOnly: false,
    archiveName: '',
    lastClickedId: '',
    filesVersion: 0,
    filterVersion: 0,
    panelOpen: false,
    previewCache: new Map(),
    previewPending: new Set(),
    previewQueue: [],
    previewActive: 0,
    persistTimer: null,
    syncUiTimer: null,
    routeTimer: null,
    filteredCache: { key: '', rows: [] },
    wasLibraryRoute: false
  };

  const ui = {};

  const injectBridge = () => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-hook.js');
    script.onload = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  };
  injectBridge();

  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
  const fileExt = name => {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,12})$/i);
    return m ? m[1] : '';
  };
  const typeSets = {
    image: new Set(['jpg','jpeg','png','gif','webp','heic','heif','bmp','tif','tiff','svg','avif','ico']),
    pdf: new Set(['pdf']),
    document: new Set(['doc','docx','odt','rtf','txt','md','pages','tex']),
    spreadsheet: new Set(['xls','xlsx','xlsm','csv','ods','numbers','tsv']),
    presentation: new Set(['ppt','pptx','odp','key']),
    archive: new Set(['zip','rar','7z','tar','gz','tgz','bz2','xz']),
    media: new Set(['mp3','wav','m4a','aac','flac','ogg','mp4','mov','mkv','webm','avi','m4v'])
  };
  const classifyFile = file => {
    const ext = file.ext || fileExt(file.name);
    for (const [type, set] of Object.entries(typeSets)) if (set.has(ext)) return type;
    const mime = String(file.mime || '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'application/pdf') return 'pdf';
    if (/word|text\//.test(mime)) return 'document';
    if (/excel|spreadsheet|csv/.test(mime)) return 'spreadsheet';
    if (/powerpoint|presentation/.test(mime)) return 'presentation';
    if (/zip|compressed|archive|tar|gzip/.test(mime)) return 'archive';
    if (/^(audio|video)\//.test(mime)) return 'media';
    return 'other';
  };
  const typeLabel = type => ({ all:'全部', image:'圖片', pdf:'PDF', document:'文件', spreadsheet:'試算表', presentation:'簡報', archive:'壓縮檔', media:'影音', other:'其他' }[type] || '其他');
  const hasDeletePair = file => /^libfile[_-]/i.test(String(file?.libraryFileId || '')) && /^file[_-]/i.test(String(file?.fileId || ''));
  const isValidFile = file => !!file && !!file.id && !!file.name && (/^(libfile[_-]|file[_-])/i.test(String(file.id)) || hasDeletePair(file));
  const normalizeFile = raw => {
    const file = { ...raw };
    file.id = String(file.libraryFileId || file.id || file.fileId || '');
    file.name = String(file.name || '未命名檔案');
    file.ext = fileExt(file.name);
    file.type = classifyFile(file);
    file.size = Number(file.size) || 0;
    return file;
  };
  const timestamp = value => {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && String(value).trim() !== '') return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const fmtDate = value => {
    const ts = timestamp(value);
    if (!ts) return '日期不明';
    const d = new Date(ts);
    return new Intl.DateTimeFormat('zh-TW', { year:'numeric', month:'2-digit', day:'2-digit' }).format(d);
  };
  const fmtDateTime = value => {
    const ts = timestamp(value);
    if (!ts) return '尚未同步';
    return new Intl.DateTimeFormat('zh-TW', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(new Date(ts));
  };
  const fmtBytes = bytes => {
    const n = Number(bytes) || 0;
    if (!n) return '—';
    const units = ['B','KB','MB','GB','TB'];
    let value = n, i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
  };

  const accountKeys = () => state.accountKey ? {
    files: `lc_files_${state.accountKey}`,
    sync: `lc_sync_${state.accountKey}`,
    checkpoint: `lc_checkpoint_${state.accountKey}`
  } : null;

  const hashAccount = async value => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
    return [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const saveUi = () => chrome.storage.local.set({
    [STORAGE_UI]: {
      theme: state.theme,
      typeFilter: state.typeFilter,
      cleanTypeFilter: state.cleanTypeFilter,
      sort: state.sort,
      deletableOnly: state.deletableOnly,
      activeTab: state.activeTab,
      concurrency: state.concurrency,
      cutoffDate: state.cutoffDate,
      dateOnly: state.dateOnly,
      archiveName: state.archiveName,
      autoSync: state.autoSync,
    }
  });

  const saveIndex = async () => {
    const keys = accountKeys();
    if (!state.accountReady || !keys) return;
    const files = [...state.files.values()].filter(isValidFile);
    await chrome.storage.local.set({ [keys.files]: files, [keys.sync]: state.lastSyncAt, [keys.checkpoint]: state.syncCheckpoint });
  };

  const scheduleIndexSave = (delay = 1600) => {
    clearTimeout(state.persistTimer);
    state.persistTimer = setTimeout(() => {
      state.persistTimer = null;
      if (!state.syncing) saveIndex();
    }, delay);
  };

  const loadUi = async () => {
    const data = await chrome.storage.local.get([STORAGE_UI, 'lc_ui_v160', 'lc_ui_v120', 'cglc_ui_v120']);
    const settings = data[STORAGE_UI] || data.lc_ui_v160 || data.lc_ui_v120 || data.cglc_ui_v120 || {};
    if (['light','dark'].includes(settings.theme)) state.theme = settings.theme;
    if (Object.keys(typeSets).concat('all','other').includes(settings.typeFilter)) state.typeFilter = settings.typeFilter;
    if (Object.keys(typeSets).concat('all','other').includes(settings.cleanTypeFilter)) state.cleanTypeFilter = settings.cleanTypeFilter;
    if (['newest','oldest','name','size'].includes(settings.sort)) state.sort = settings.sort;
    state.deletableOnly = !!settings.deletableOnly;
    if (['files','clean','backup','settings'].includes(settings.activeTab)) state.activeTab = settings.activeTab;
    state.concurrency = Math.max(1, Math.min(3, Number(settings.concurrency) || 2));
    state.autoSync = settings.autoSync !== false;
    state.cutoffDate = typeof settings.cutoffDate === 'string' ? settings.cutoffDate : '';
    state.dateOnly = !!settings.dateOnly;
    state.archiveName = typeof settings.archiveName === 'string' ? settings.archiveName : '';
  };

  const switchAccount = async identifier => {
    if (!identifier) {
      state.accountReady = false;
      state.accountKey = '';
      state.files.clear();
      state.selected.clear();
      state.lastSyncAt = 0;
      state.syncCheckpoint = null;
      state.previewCache.clear();
      invalidateData();
      updateAll();
      return;
    }
    const key = await hashAccount(identifier);
    if (state.accountReady && state.accountKey === key) return;

    state.accountKey = key;
    state.accountReady = true;
    state.files.clear();
    state.selected.clear();
    window.postMessage({ channel:CHANNEL, type:'CLEAR_PREVIEWS', payload:{} }, location.origin);
    state.previewCache.clear();
    state.previewPending.clear();
    state.lastClickedId = '';
    state.syncCheckpoint = null;
    state.filesVersion++;
    state.filteredCache.key = '';

    const keys = accountKeys();
    const data = await chrome.storage.local.get([keys.files, keys.sync, keys.checkpoint]);
    for (const raw of data[keys.files] || []) {
      const file = normalizeFile(raw);
      if (isValidFile(file)) state.files.set(file.id, file);
    }
    state.lastSyncAt = Number(data[keys.sync]) || 0;
    state.syncCheckpoint = data[keys.checkpoint] || null;
    invalidateData();
    updateAll();
    if (isLibraryRoute() && state.autoSync) setTimeout(() => startSync(true), 180);
  };

  const isLibraryRoute = () => location.pathname.startsWith('/library');
  const applyRouteVisibility = () => {
    if (!ui.host) return;
    const inLibrary = isLibraryRoute();
    ui.host.style.display = inLibrary ? '' : 'none';
    if (inLibrary && !state.wasLibraryRoute) {
      state.wasLibraryRoute = true;
      if (state.autoSync && state.accountReady && !state.syncing) setTimeout(() => startSync(true), 250);
    } else if (!inLibrary) {
      state.wasLibraryRoute = false;
    }
  };

  const invalidateData = () => {
    state.filesVersion++;
    state.filterVersion++;
    state.filteredCache.key = '';
  };

  const filteredFiles = () => {
    const key = [state.filesVersion, state.filterVersion, state.query, state.typeFilter, state.sort, state.deletableOnly, state.dateOnly, state.cutoffDate].join('|');
    if (state.filteredCache.key === key) return state.filteredCache.rows;
    const query = state.query.trim().toLocaleLowerCase('zh-TW');
    let rows = [...state.files.values()].filter(file => {
      if (state.deletableOnly && !hasDeletePair(file)) return false;
      if (state.dateOnly && state.cutoffDate) {
        const cutoff = new Date(`${state.cutoffDate}T00:00:00`).getTime();
        const ts = timestamp(file.created);
        if (!ts || !Number.isFinite(cutoff) || ts >= cutoff) return false;
      }
      if (state.typeFilter !== 'all' && file.type !== state.typeFilter) return false;
      if (query) {
        const haystack = `${file.name} ${file.ext} ${file.mime || ''} ${typeLabel(file.type)} ${file.id}`.toLocaleLowerCase('zh-TW');
        const tokens = query.replace(/\*/g, ' ').split(/\s+/).filter(Boolean);
        if (tokens.length && !tokens.every(token => haystack.includes(token))) return false;
      }
      return true;
    });
    if (state.sort === 'name') rows.sort((a,b) => a.name.localeCompare(b.name, 'zh-TW', { numeric:true, sensitivity:'base' }));
    else if (state.sort === 'size') rows.sort((a,b) => (b.size || 0) - (a.size || 0));
    else if (state.sort === 'oldest') rows.sort((a,b) => (timestamp(a.created) || Infinity) - (timestamp(b.created) || Infinity));
    else rows.sort((a,b) => (timestamp(b.created) || 0) - (timestamp(a.created) || 0));
    state.filteredCache = { key, rows };
    return rows;
  };

  const specifiedDateStartTimestamp = () => {
    if (!state.cutoffDate) return 0;
    const cutoff = new Date(`${state.cutoffDate}T00:00:00`).getTime();
    return Number.isFinite(cutoff) ? cutoff : 0;
  };

  const oldFiles = () => {
    const cutoff = specifiedDateStartTimestamp();
    if (!cutoff) return [];
    return [...state.files.values()].filter(file => {
      const ts = timestamp(file.created);
      return !!ts && ts < cutoff;
    });
  };

  const cleanFiles = () => {
    const rows = oldFiles();
    if (state.cleanTypeFilter === 'all') return rows;
    return rows.filter(file => file.type === state.cleanTypeFilter);
  };

  const dateCoverage = () => {
    const dated = [...state.files.values()]
      .map(file => ({ file, ts: timestamp(file.created) }))
      .filter(item => !!item.ts)
      .sort((a,b) => a.ts - b.ts);
    return {
      count: dated.length,
      missing: Math.max(0, state.files.size - dated.length),
      oldest: dated.length ? dated[0].ts : 0,
      newest: dated.length ? dated[dated.length - 1].ts : 0
    };
  };

  const selectedFiles = () => [...state.selected].map(id => state.files.get(id)).filter(Boolean);
  const selectedBytes = () => selectedFiles().reduce((sum, file) => sum + (file.size || 0), 0);

  const iconSvg = (name, size = 18) => {
    const common = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
    const paths = {
      search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
      sync:'<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>',
      moon:'<path d="M20.5 13.2A8 8 0 1 1 10.8 3.5a6.5 6.5 0 0 0 9.7 9.7Z"/>',
      sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
      close:'<path d="m6 6 12 12M18 6 6 18"/>',
      download:'<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/>',
      trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
      folder:'<path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
      magic:'<path d="m15 4 5 5L8 21H3v-5Z"/><path d="m14 5 5 5M6 4v4M4 6h4M18 15v4M16 17h4"/>',
      settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.8-2.8.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V3h4v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10v4h-.2a1.7 1.7 0 0 0-1.4 1Z"/>',
      file:'<path d="M6 2h8l4 4v16H6Z"/><path d="M14 2v5h5"/>',
      chevron:'<path d="m9 18 6-6-6-6"/>'
    };
    return `<svg ${common}>${paths[name] || paths.file}</svg>`;
  };

  const fileGlyph = file => {
    const label = file.type === 'pdf' ? 'PDF' : file.ext ? file.ext.slice(0, 4).toUpperCase() : 'FILE';
    return `<div class="lc-file-glyph lc-type-${file.type}"><span>${escapeHtml(label)}</span></div>`;
  };

  const mount = async () => {
    const host = document.createElement('div');
    host.id = 'lc-extension-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('panel.css');
    shadow.appendChild(link);

    const root = document.createElement('div');
    root.className = 'lc-root';
    root.innerHTML = `
      <button class="lc-launcher" id="lc-launcher" aria-label="開啟 Library Cleaner">
        <img src="${chrome.runtime.getURL('icons/icon48.png')}" alt="" />
      </button>
      <section class="lc-panel" id="lc-panel" aria-label="Library Cleaner">
        <aside class="lc-sidebar">
          <div class="lc-brand">
            <img src="${chrome.runtime.getURL('icons/icon48.png')}" class="lc-brand-icon" alt="" />
            <div class="lc-brand-copy">
              <div class="lc-brand-title"><strong>Library Cleaner</strong></div>
              <span class="lc-brand-slogan">整理、備份與清理 ChatGPT 檔案</span>
            </div>
            <span class="lc-version-badge">v${VERSION}</span>
          </div>
          <nav class="lc-tabs" aria-label="主要功能">
            <button data-tab="files">${iconSvg('folder',18)}<span>檔案管理</span></button>
            <button data-tab="clean">${iconSvg('magic',18)}<span>智慧清理</span></button>
            <button data-tab="backup">${iconSvg('download',18)}<span>備份匯出</span></button>
            <button data-tab="settings">${iconSvg('settings',18)}<span>設定</span></button>
          </nav>
        </aside>

        <div class="lc-workspace">
          <header class="lc-topbar">
            <div class="lc-metrics">
              <div><strong id="lc-total">0</strong><span>檔案總數</span></div>
              <div><strong id="lc-selected">0</strong><span>已選取</span></div>
              <div><strong id="lc-known-size">—</strong><span>總容量</span></div>
            </div>
            <div class="lc-top-actions">
              <div class="lc-sync-copy"><strong id="lc-sync-title">準備檔案庫</strong><span id="lc-sync-subtitle">正在建立安全連線</span></div>
              <span class="lc-status" id="lc-status"><i></i><span>連線中</span></span>
              <button class="lc-button lc-button-accent" id="lc-sync">${iconSvg('sync',16)}<span>同步</span></button>
              <button class="lc-icon-button lc-theme" id="lc-theme" title="切換日夜模式"></button>
              <button class="lc-icon-button" id="lc-close" title="關閉">${iconSvg('close')}</button>
            </div>
          </header>
          <div class="lc-sync-progress"><span id="lc-sync-bar"></span></div>

          <main class="lc-content">
            <section class="lc-view lc-files-view" data-view="files">
              <div class="lc-file-toolbar">
                <div class="lc-search-wrap">${iconSvg('search',19)}<input id="lc-search" type="search" autocomplete="off" placeholder="搜尋檔名、類型、ID 或內容…"><button id="lc-search-clear" class="lc-search-clear" aria-label="清除搜尋">×</button></div>
                <select id="lc-sort" class="lc-select" aria-label="排序">
                  <option value="newest">建立日期（新 → 舊）</option>
                  <option value="oldest">建立日期（舊 → 新）</option>
                  <option value="name">名稱 A → Z</option>
                  <option value="size">容量大 → 小</option>
                </select>
              </div>
              <div class="lc-filterbar">
                <div class="lc-types" id="lc-types"></div>
                <div class="lc-bulk-tools">
                  <button class="lc-text-button" id="lc-select-all">全選結果</button>
                  <button class="lc-text-button" id="lc-select-100">前 100</button>
                  <button class="lc-text-button" id="lc-clear-selection">清除</button>
                </div>
              </div>
              <div class="lc-table-shell">
                <div class="lc-table-head">
                  <div><input type="checkbox" id="lc-master-check" aria-label="選取目前結果"></div>
                  <div>名稱</div><div>類型</div><div>副檔名</div><div>建立日期</div><div>大小</div>
                </div>
                <div class="lc-viewport" id="lc-viewport">
                  <div class="lc-spacer" id="lc-spacer"><div class="lc-row-layer" id="lc-row-layer"></div></div>
                  <div class="lc-empty" id="lc-empty"><strong>沒有符合條件的檔案</strong><span>調整搜尋或篩選條件後再試。</span></div>
                </div>
              </div>
            </section>

            <section class="lc-view" data-view="clean">
              <div class="lc-page-heading"><div><h2>智慧清理</h2><p>找出指定日期以前建立的檔案，預覽後再選取。</p></div></div>
              <div class="lc-clean-toolbar">
                <label class="lc-clean-date">指定日期<input id="lc-cutoff" type="date" class="lc-input"></label>
                <div class="lc-clean-metrics"><span>可清理檔案</span><strong id="lc-old-count">0 個</strong><small id="lc-old-size">—</small></div>
              </div>
              <div class="lc-clean-context">
                <div class="lc-clean-types" id="lc-clean-types"></div>
                <div class="lc-clean-coverage" id="lc-clean-coverage"></div>
              </div>
              <div class="lc-clean-results">
                <div class="lc-clean-table-head"><span class="lc-clean-head-check"><input type="checkbox" id="lc-clean-master-check" aria-label="選取目前清理結果"></span><span>名稱</span><span>類型</span><span>建立日期</span><span>大小</span></div>
                <div id="lc-clean-list" class="lc-clean-list"></div>
                <div id="lc-clean-empty" class="lc-clean-empty">選擇指定日期後，較早建立的檔案會顯示在這裡。</div>
              </div>
            </section>

            <section class="lc-view" data-view="backup">
              <div class="lc-page-heading"><div><h2>備份匯出</h2><p>將選取檔案打包成 ZIP，備份完成後再決定是否清理。</p></div></div>
              <div class="lc-form-grid lc-backup-name-grid">
                <label>ZIP 名稱<input id="lc-archive-name" class="lc-input" placeholder="chatgpt-library-2026-09"></label>
              </div>
              <div class="lc-backup-summary"><div><span>目前選取</span><strong id="lc-backup-count">0 個檔案</strong><small id="lc-backup-size">—</small></div><button class="lc-button lc-button-accent" id="lc-backup-now">${iconSvg('download',16)}<span>備份所選</span></button></div>
              <div class="lc-operation-progress" id="lc-backup-progress"><span></span></div>
              <div class="lc-backup-status" id="lc-backup-status">選取檔案後可開始備份。</div>
            </section>

            <section class="lc-view" data-view="settings">
              <div class="lc-page-heading"><div><h2>設定</h2><p>管理外觀、同步與目前帳號的本機索引。</p></div></div>
              <div class="lc-settings-list">
                <div class="lc-setting-row"><div><strong>外觀</strong><span>日間與夜間模式</span></div><button class="lc-button lc-button-secondary" id="lc-theme-settings">切換主題</button></div>
                <div class="lc-setting-row"><div><strong>刪除處理速度</strong><span>建議使用標準，兼顧速度與穩定性。</span></div><select id="lc-concurrency" class="lc-select"><option value="1">穩定</option><option value="2">標準</option><option value="3">快速</option></select></div>
                <div class="lc-setting-row"><div><strong>目前帳號索引</strong><span id="lc-index-info">尚未建立</span></div><button class="lc-button lc-button-secondary" id="lc-clear-index">清除本機索引</button></div>
                <div class="lc-setting-row"><div><strong>自動同步</strong><span>開啟檔案庫時，自動檢查新增與變更的檔案。</span></div><label class="lc-switch"><input type="checkbox" id="lc-auto-sync"><span class="lc-switch-track"><span class="lc-switch-thumb"></span></span></label></div>
                <div class="lc-setting-row"><div><strong>同步</strong><span id="lc-settings-sync-state">尚未同步</span></div><button class="lc-button lc-button-secondary" id="lc-settings-sync">立即同步</button></div>
              </div>
            </section>
          </main>

          <footer class="lc-actionbar">
            <div class="lc-selection-summary"><strong id="lc-footer-selected">已選取 0 個檔案</strong><span id="lc-footer-sub">0 B</span></div>
            <div class="lc-action-buttons">
              <button class="lc-button lc-button-secondary" id="lc-footer-backup">${iconSvg('download',16)}備份選取</button>
              <button class="lc-button lc-button-danger" id="lc-delete">${iconSvg('trash',16)}刪除選取</button>
            </div>
          </footer>
        </div>
      </section>
    `;
    shadow.appendChild(root);
    document.documentElement.appendChild(host);

    Object.assign(ui, {
      host, shadow, root,
      launcher: shadow.getElementById('lc-launcher'), panel: shadow.getElementById('lc-panel'), close: shadow.getElementById('lc-close'),
      theme: shadow.getElementById('lc-theme'), status: shadow.getElementById('lc-status'), total: shadow.getElementById('lc-total'), knownSize: shadow.getElementById('lc-known-size'),
      selected: shadow.getElementById('lc-selected'), selectedSize: shadow.getElementById('lc-selected-size'), syncTitle: shadow.getElementById('lc-sync-title'), syncSubtitle: shadow.getElementById('lc-sync-subtitle'),
      sync: shadow.getElementById('lc-sync'), syncBar: shadow.getElementById('lc-sync-bar'), tabs: [...shadow.querySelectorAll('[data-tab]')], views: [...shadow.querySelectorAll('[data-view]')],
      search: shadow.getElementById('lc-search'), searchClear: shadow.getElementById('lc-search-clear'), sort: shadow.getElementById('lc-sort'), types: shadow.getElementById('lc-types'),
      selectAll: shadow.getElementById('lc-select-all'), select100: shadow.getElementById('lc-select-100'), clearSelection: shadow.getElementById('lc-clear-selection'), masterCheck: shadow.getElementById('lc-master-check'),
      viewport: shadow.getElementById('lc-viewport'), spacer: shadow.getElementById('lc-spacer'), rowLayer: shadow.getElementById('lc-row-layer'), empty: shadow.getElementById('lc-empty'),
      cutoff: shadow.getElementById('lc-cutoff'), oldCount: shadow.getElementById('lc-old-count'), oldSize: shadow.getElementById('lc-old-size'), cleanMasterCheck: shadow.getElementById('lc-clean-master-check'), cleanList: shadow.getElementById('lc-clean-list'), cleanEmpty: shadow.getElementById('lc-clean-empty'), cleanCoverage: shadow.getElementById('lc-clean-coverage'), cleanTypes: shadow.getElementById('lc-clean-types'),
      archiveName: shadow.getElementById('lc-archive-name'),
      backupCount: shadow.getElementById('lc-backup-count'), backupSize: shadow.getElementById('lc-backup-size'), backupNow: shadow.getElementById('lc-backup-now'), backupProgress: shadow.getElementById('lc-backup-progress'), backupStatus: shadow.getElementById('lc-backup-status'),
      themeSettings: shadow.getElementById('lc-theme-settings'), concurrency: shadow.getElementById('lc-concurrency'), autoSync: shadow.getElementById('lc-auto-sync'), indexInfo: shadow.getElementById('lc-index-info'), settingsSyncState: shadow.getElementById('lc-settings-sync-state'), clearIndex: shadow.getElementById('lc-clear-index'), settingsSync: shadow.getElementById('lc-settings-sync'),
      footerSelected: shadow.getElementById('lc-footer-selected'), footerSub: shadow.getElementById('lc-footer-sub'), footerBackup: shadow.getElementById('lc-footer-backup'), deleteButton: shadow.getElementById('lc-delete')
    });

    bindEvents();
    applyTheme();
    updateAll();
    applyRouteVisibility();
  };

  const bindEvents = () => {
    ui.launcher.addEventListener('click', () => { state.panelOpen = true; updatePanelOpen(); setTimeout(renderVirtualRows, 0); });
    ui.close.addEventListener('click', () => { state.panelOpen = false; updatePanelOpen(); });
    ui.theme.addEventListener('click', toggleTheme);
    ui.themeSettings.addEventListener('click', toggleTheme);
    ui.sync.addEventListener('click', () => state.syncing ? stopSync() : state.enriching ? stopMetadataEnrichment() : startSync(false));
    ui.settingsSync.addEventListener('click', () => startSync(false));

    ui.tabs.forEach(button => button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab;
      saveUi();
      updateTabs();
      if (state.activeTab === 'files') setTimeout(updateFileView, 0);
      else if (state.activeTab === 'clean') updateCleanView();
      else if (state.activeTab === 'backup') updateBackupView();
      else if (state.activeTab === 'settings') updateSettings();
    }));

    let searchTimer;
    let composingSearch = false;
    const applySearch = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = ui.search.value;
        state.filterVersion++;
        state.filteredCache.key = '';
        ui.viewport.scrollTop = 0;
        updateFileView();
      }, 60);
    };
    ui.search.addEventListener('compositionstart', () => { composingSearch = true; });
    ui.search.addEventListener('compositionend', () => { composingSearch = false; applySearch(); });
    ui.search.addEventListener('input', () => { if (!composingSearch) applySearch(); });
    ui.search.addEventListener('search', applySearch);
    ui.searchClear.addEventListener('click', () => {
      state.query = '';
      ui.search.value = '';
      state.filterVersion++;
      state.filteredCache.key = '';
      ui.viewport.scrollTop = 0;
      updateFileView();
      ui.search.focus();
    });
    ui.sort.addEventListener('change', event => { state.sort = event.target.value; state.filterVersion++; state.filteredCache.key = ''; saveUi(); ui.viewport.scrollTop = 0; updateFileView(); });

    ui.types.addEventListener('click', event => {
      const button = event.target.closest('[data-type]');
      if (!button) return;
      state.typeFilter = button.dataset.type;
      state.filterVersion++;
      state.filteredCache.key = '';
      saveUi();
      ui.viewport.scrollTop = 0;
      updateFileView();
    });

    ui.selectAll.addEventListener('click', () => { const rows = filteredFiles().filter(hasDeletePair); const allSelected = rows.length > 0 && rows.every(file => state.selected.has(file.id)); for (const file of rows) allSelected ? state.selected.delete(file.id) : state.selected.add(file.id); updateSelectionUi(); renderVirtualRows(); });
    ui.select100.addEventListener('click', () => { for (const file of filteredFiles().filter(hasDeletePair).slice(0, 100)) state.selected.add(file.id); updateSelectionUi(); renderVirtualRows(); });
    ui.clearSelection.addEventListener('click', clearSelection);
    ui.masterCheck.addEventListener('change', event => {
      const rows = filteredFiles().filter(hasDeletePair);
      const shouldSelect = !!event.currentTarget.checked;
      for (const file of rows) {
        if (shouldSelect) state.selected.add(file.id);
        else state.selected.delete(file.id);
      }
      updateSelectionUi();
      renderVirtualRows();
    });

    let scrollRaf = 0;
    ui.viewport.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; renderVirtualRows(); });
    }, { passive: true });

    ui.rowLayer.addEventListener('click', event => {
      const checkbox = event.target.closest('input[type="checkbox"][data-file-id]');
      if (!checkbox) return;
      const id = checkbox.dataset.fileId;
      const rows = filteredFiles();
      if (event.shiftKey && state.lastClickedId) {
        const a = rows.findIndex(file => file.id === state.lastClickedId);
        const b = rows.findIndex(file => file.id === id);
        if (a >= 0 && b >= 0) {
          const [from, to] = a < b ? [a, b] : [b, a];
          const select = checkbox.checked;
          for (const file of rows.slice(from, to + 1)) {
            if (!hasDeletePair(file)) continue;
            if (select) state.selected.add(file.id); else state.selected.delete(file.id);
          }
        }
      } else {
        if (checkbox.checked) state.selected.add(id); else state.selected.delete(id);
      }
      state.lastClickedId = id;
      updateSelectionUi();
      renderVirtualRows();
    });

    ui.cutoff.addEventListener('change', event => { state.cutoffDate = event.target.value; saveUi(); updateCleanView(); });
    ui.cleanTypes.addEventListener('click', event => {
      const button = event.target.closest('[data-clean-type]');
      if (!button) return;
      state.cleanTypeFilter = button.dataset.cleanType;
      saveUi();
      updateCleanView();
    });
    ui.cleanMasterCheck.addEventListener('change', event => {
      const rows = cleanFiles().filter(hasDeletePair);
      const shouldSelect = !!event.target.checked;
      for (const file of rows) {
        if (shouldSelect) state.selected.add(file.id);
        else state.selected.delete(file.id);
      }
      updateSelectionUi();
      updateCleanView();
    });
    ui.cleanList.addEventListener('change', event => {
      const checkbox = event.target.closest('input[type="checkbox"][data-clean-id]');
      if (!checkbox) return;
      const file = state.files.get(checkbox.dataset.cleanId);
      if (!file || !hasDeletePair(file)) { checkbox.checked = false; return; }
      if (checkbox.checked) state.selected.add(checkbox.dataset.cleanId); else state.selected.delete(checkbox.dataset.cleanId);
      updateSelectionUi();
      updateCleanView();
    });

    ui.archiveName.addEventListener('change', event => { state.archiveName = event.target.value.trim(); saveUi(); });
    ui.backupNow.addEventListener('click', startBackup);
    ui.footerBackup.addEventListener('click', startBackup);
    ui.deleteButton.addEventListener('click', bulkDelete);
    ui.concurrency.addEventListener('change', event => { state.concurrency = Math.max(1, Math.min(3, Number(event.target.value) || 2)); saveUi(); });
    ui.autoSync.addEventListener('change', event => { state.autoSync = !!event.target.checked; saveUi(); if (state.autoSync && isLibraryRoute() && state.accountReady && !state.syncing) startSync(true); });
    ui.clearIndex.addEventListener('click', clearCurrentIndex);
  };

  const clearSelection = () => {
    state.selected.clear();
    state.lastClickedId = '';
    updateSelectionUi();
    renderVirtualRows();
  };

  const updatePanelOpen = () => {
    ui.panel.classList.toggle('is-open', state.panelOpen);
    ui.launcher.classList.toggle('is-hidden', state.panelOpen);
  };

  const applyTheme = () => {
    ui.root.dataset.theme = state.theme;
    ui.theme.innerHTML = state.theme === 'dark' ? `${iconSvg('sun',15)}<span>Light</span>` : `${iconSvg('moon',15)}<span>Dark</span>`;
  };
  const toggleTheme = () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveUi();
  };

  const updateTabs = () => {
    ui.tabs.forEach(button => button.classList.toggle('is-active', button.dataset.tab === state.activeTab));
    ui.views.forEach(view => view.classList.toggle('is-active', view.dataset.view === state.activeTab));
  };

  const updateHeader = () => {
    const total = state.files.size;
    const knownBytes = [...state.files.values()].reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    ui.total.textContent = total.toLocaleString('zh-TW');
    ui.knownSize.textContent = knownBytes ? fmtBytes(knownBytes) : '—';
    ui.selected.textContent = state.selected.size.toLocaleString('zh-TW');
    if (ui.selectedSize) ui.selectedSize.textContent = state.selected.size ? fmtBytes(selectedBytes()) : '—';

    const statusText = ui.status.querySelector('span');
    if (!state.bridgeReady) {
      ui.status.dataset.state = 'pending';
      statusText.textContent = '連線中';
    } else if (!state.accountReady) {
      ui.status.dataset.state = 'pending';
      statusText.textContent = '帳號識別中';
    } else {
      ui.status.dataset.state = 'ready';
      statusText.textContent = '已連線';
    }

    if (state.syncing) {
      const p = state.syncProgress || {};
      ui.syncTitle.textContent = '正在同步';
      ui.syncSubtitle.textContent = `${(p.found || total).toLocaleString('zh-TW')} 個檔案${p.pages ? ` · 第 ${p.pages} 頁` : ''}`;
      ui.sync.innerHTML = `<span class="lc-sync-icon lc-spin">${iconSvg('sync',16)}</span><span>同步中</span>`;
      ui.sync.classList.add('is-stop');
      const percent = p.total ? Math.min(100, ((p.found || 0) / p.total) * 100) : 0;
      ui.syncBar.style.width = `${percent}%`;
      ui.syncBar.parentElement.classList.add('is-active');
      ui.syncBar.parentElement.classList.toggle('is-indeterminate', !p.total);
    } else if (state.enriching) {
      const p = state.enrichProgress || {};
      ui.syncTitle.textContent = '補全檔案資訊';
      ui.syncSubtitle.textContent = `${(p.done || 0).toLocaleString('zh-TW')} / ${(p.total || 0).toLocaleString('zh-TW')} · 正在取得日期與容量`;
      ui.sync.innerHTML = `<span class="lc-sync-icon lc-spin">${iconSvg('sync',16)}</span><span>停止</span>`;
      ui.sync.classList.add('is-stop');
      const percent = p.total ? Math.min(100, ((p.done || 0) / p.total) * 100) : 0;
      ui.syncBar.style.width = `${percent}%`;
      ui.syncBar.parentElement.classList.add('is-active');
      ui.syncBar.parentElement.classList.remove('is-indeterminate');
    } else {
      const error = state.syncProgress?.error;
      if (error) {
        ui.syncTitle.textContent = '同步失敗';
        ui.syncSubtitle.textContent = String(error).replace(/^同步失敗：?/, '').slice(0, 80);
      } else {
        ui.syncTitle.textContent = state.lastSyncAt ? '同步完成' : '尚未同步';
        ui.syncSubtitle.textContent = state.lastSyncAt ? `${fmtDateTime(state.lastSyncAt)} · ${total.toLocaleString('zh-TW')} 個檔案` : '取得完整檔案清單';
      }
      ui.sync.innerHTML = `${iconSvg('sync',16)}<span>同步</span>`;
      ui.sync.classList.remove('is-stop');
      ui.syncBar.style.width = '0%';
      ui.syncBar.parentElement.classList.remove('is-active', 'is-indeterminate');
    }
  };

  const updateTypes = () => {
    const counts = { all: state.files.size, image:0, pdf:0, document:0, spreadsheet:0, presentation:0, archive:0, media:0, other:0 };
    for (const file of state.files.values()) counts[file.type] = (counts[file.type] || 0) + 1;
    ui.types.innerHTML = ['all','image','pdf','document','spreadsheet','presentation','archive','media','other'].map(type =>
      `<button class="${state.typeFilter === type ? 'is-active' : ''}" data-type="${type}"><span>${typeLabel(type)}</span><small>${counts[type] || 0}</small></button>`
    ).join('');
  };

  const updateFileView = () => {
    ui.sort.value = state.sort;
    if (ui.search.value !== state.query && ui.shadow.activeElement !== ui.search) ui.search.value = state.query;
    updateTypes();
    const rows = filteredFiles();
    ui.empty.classList.toggle('is-visible', rows.length === 0);
    const manageableRows = rows.filter(hasDeletePair);
    ui.masterCheck.checked = !!manageableRows.length && manageableRows.every(file => state.selected.has(file.id));
    ui.masterCheck.indeterminate = manageableRows.some(file => state.selected.has(file.id)) && !ui.masterCheck.checked;
    ui.selectAll.textContent = ui.masterCheck.checked ? '取消全選' : '全選結果';
    ui.masterCheck.setAttribute('aria-label', ui.masterCheck.checked ? '取消選取目前結果' : '選取目前結果');
    renderVirtualRows();
  };

  const renderVirtualRows = () => {
    if (!ui.viewport || state.activeTab !== 'files') return;
    const rows = filteredFiles();
    const viewportHeight = ui.viewport.clientHeight || 420;
    const scrollTop = ui.viewport.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(rows.length, start + visibleCount);
    ui.spacer.style.height = `${Math.max(1, rows.length * ROW_HEIGHT)}px`;

    const html = [];
    for (let i = start; i < end; i++) {
      const file = rows[i];
      const selected = state.selected.has(file.id);
      const preview = state.previewCache.get(file.id) || file.thumbnailUrl || '';
      if (file.type === 'image' && !preview && file.fileId) queuePreview(file);
      const visual = preview
        ? `<div class="lc-thumb"><img src="${escapeHtml(preview)}" alt="" loading="lazy" decoding="async" onerror="this.closest('.lc-thumb').classList.add('is-error')"><div class="lc-thumb-fallback">${fileGlyph(file)}</div></div>`
        : fileGlyph(file);
      html.push(`
        <div class="lc-row ${selected ? 'is-selected' : ''}" data-row-id="${escapeHtml(file.id)}" style="transform:translateY(${i * ROW_HEIGHT}px)">
          <div class="lc-cell lc-cell-check"><input type="checkbox" data-file-id="${escapeHtml(file.id)}" ${selected ? 'checked' : ''} ${hasDeletePair(file) ? '' : 'disabled title="缺少刪除所需識別資訊"'}></div>
          <div class="lc-cell lc-name-cell">${visual}<div class="lc-file-copy"><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><span>${escapeHtml(file.mime || typeLabel(file.type))}</span></div></div>
          <div class="lc-cell"><span class="lc-kind">${typeLabel(file.type)}</span></div>
          <div class="lc-cell lc-muted">${file.ext ? `.${escapeHtml(file.ext)}` : '—'}</div>
          <div class="lc-cell lc-muted">${fmtDate(file.created)}</div>
          <div class="lc-cell lc-muted">${fmtBytes(file.size)}</div>
        </div>
      `);
    }
    ui.rowLayer.innerHTML = html.join('');
  };

  const queuePreview = file => {
    if (!file?.fileId || state.previewCache.has(file.id) || state.previewPending.has(file.id)) return;
    if (state.previewQueue.length >= 24) return;
    state.previewPending.add(file.id);
    state.previewQueue.push(file);
    pumpPreviews();
  };
  const pumpPreviews = () => {
    while (state.previewActive < PREVIEW_CONCURRENCY && state.previewQueue.length) {
      const file = state.previewQueue.shift();
      state.previewActive++;
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        previewResolvers.delete(requestId);
        state.previewPending.delete(file.id);
        state.previewActive--;
        pumpPreviews();
      }, 15000);
      previewResolvers.set(requestId, payload => {
        clearTimeout(timeout);
        if (payload?.ok && payload.url) state.previewCache.set(file.id, payload.url);
        state.previewPending.delete(file.id);
        state.previewActive--;
        previewResolvers.delete(requestId);
        if (state.activeTab === 'clean') updateCleanView();
        else renderVirtualRows();
        pumpPreviews();
      });
      window.postMessage({ channel: CHANNEL, type:'RESOLVE_PREVIEW', payload:{ requestId, fileId:file.fileId } }, location.origin);
    }
  };
  const previewResolvers = new Map();

  const updateSelectionUi = () => {
    const count = state.selected.size;
    const bytes = selectedBytes();
    ui.selected.textContent = count.toLocaleString('zh-TW');
    if (ui.selectedSize) ui.selectedSize.textContent = count ? fmtBytes(bytes) : '—';
    ui.footerSelected.textContent = count ? `已選取 ${count.toLocaleString('zh-TW')} 個檔案` : '尚未選取檔案';
    ui.footerSub.textContent = count ? (bytes ? fmtBytes(bytes) : '容量未提供') : '選取後可備份或刪除';
    ui.footerBackup.disabled = !count || state.downloading;
    ui.deleteButton.disabled = !count || state.deleting;
    ui.backupNow.disabled = !count && !state.downloading;
    ui.backupCount.textContent = `${count.toLocaleString('zh-TW')} 個檔案`;
    ui.backupSize.textContent = count ? fmtBytes(bytes) : '—';
    const rows = filteredFiles();
    const manageableRows = rows.filter(hasDeletePair);
    ui.masterCheck.checked = !!manageableRows.length && manageableRows.every(file => state.selected.has(file.id));
    ui.masterCheck.indeterminate = manageableRows.some(file => state.selected.has(file.id)) && !ui.masterCheck.checked;
    ui.selectAll.textContent = ui.masterCheck.checked ? '取消全選' : '全選結果';
    ui.masterCheck.setAttribute('aria-label', ui.masterCheck.checked ? '取消選取目前結果' : '選取目前結果');
  };

  const updateCleanView = () => {
    ui.cutoff.value = state.cutoffDate;
    const allDateRows = oldFiles().sort((a,b) => (timestamp(a.created)||0) - (timestamp(b.created)||0));
    const rows = cleanFiles().sort((a,b) => (timestamp(a.created)||0) - (timestamp(b.created)||0));
    const selectableRows = rows.filter(hasDeletePair);
    const bytes = rows.reduce((sum, file) => sum + (file.size || 0), 0);
    const coverage = dateCoverage();

    ui.oldCount.textContent = `${rows.length.toLocaleString('zh-TW')} 個`;
    ui.oldSize.textContent = fmtBytes(bytes);
    const selectedCleanCount = selectableRows.filter(file => state.selected.has(file.id)).length;
    const allSelected = !!selectableRows.length && selectedCleanCount === selectableRows.length;
    ui.cleanMasterCheck.disabled = !selectableRows.length;
    ui.cleanMasterCheck.checked = allSelected;
    ui.cleanMasterCheck.indeterminate = selectedCleanCount > 0 && !allSelected;
    ui.cleanMasterCheck.setAttribute('aria-label', allSelected ? '取消選取目前清理結果' : '選取目前清理結果');

    const cleanCounts = { all: allDateRows.length, image:0, pdf:0, document:0, spreadsheet:0, presentation:0, archive:0, media:0, other:0 };
    for (const file of allDateRows) cleanCounts[file.type] = (cleanCounts[file.type] || 0) + 1;
    ui.cleanTypes.innerHTML = ['all','image','pdf','document','spreadsheet','presentation','archive','media','other'].map(type =>
      `<button class="${state.cleanTypeFilter===type?'is-active':''}" data-clean-type="${type}">${typeLabel(type)} <span>${(cleanCounts[type]||0).toLocaleString('zh-TW')}</span></button>`
    ).join('');

    if (ui.cleanCoverage) {
      if (!state.cutoffDate) {
        ui.cleanCoverage.textContent = '選擇一個日期，會列出該日期之前建立的檔案；指定日期當天不會包含在內。';
      } else if (!coverage.count) {
        ui.cleanCoverage.textContent = '目前檔案庫尚未取得可用的建立日期。';
      } else {
        const d = new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(specifiedDateStartTimestamp()));
        ui.cleanCoverage.textContent = `顯示 ${d} 之前建立的檔案，不包含 ${d} 當天。`;
      }
    }

    const visible = rows.slice(0, 150);
    ui.cleanList.innerHTML = visible.map(file => {
      const selectable = hasDeletePair(file);
      const preview = state.previewCache.get(file.id) || file.thumbnailUrl || '';
      if (file.type === 'image' && !preview && file.fileId) queuePreview(file);
      const visual = preview
        ? `<div class="lc-clean-thumb"><img src="${escapeHtml(preview)}" alt="" loading="lazy" decoding="async" onerror="this.closest('.lc-clean-thumb').classList.add('is-error')"><div class="lc-clean-thumb-fallback">${fileGlyph(file)}</div></div>`
        : fileGlyph(file);
      return `
      <label class="lc-clean-row ${selectable ? '' : 'is-disabled'}">
        <input type="checkbox" data-clean-id="${escapeHtml(file.id)}" ${state.selected.has(file.id) ? 'checked' : ''} ${selectable ? '' : 'disabled'}>
        <span class="lc-clean-file">${visual}<span class="lc-clean-copy"><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.ext ? '.'+file.ext : file.mime || '')}</small></span></span>
        <span><span class="lc-kind">${typeLabel(file.type)}</span></span>
        <span>${fmtDate(file.created)}</span>
        <span>${fmtBytes(file.size || 0)}</span>
      </label>`;
    }).join('');

    ui.cleanEmpty.style.display = rows.length ? 'none' : 'flex';
    if (rows.length > visible.length) {
      ui.cleanEmpty.style.display = 'flex';
      ui.cleanEmpty.textContent = `另有 ${(rows.length-visible.length).toLocaleString('zh-TW')} 個檔案；選取全部時會一併選取。`;
    } else if (!rows.length) {
      if (!state.cutoffDate) {
        ui.cleanEmpty.textContent = '選擇指定日期後，較早建立的檔案會顯示在這裡。';
      } else if (!coverage.count) {
        ui.cleanEmpty.textContent = '目前檔案庫尚未取得可用的建立日期。';
      } else if (state.cleanTypeFilter !== 'all' && allDateRows.length) {
        ui.cleanEmpty.textContent = `指定日期之前沒有「${typeLabel(state.cleanTypeFilter)}」檔案。`;
      } else {
        const d = new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(specifiedDateStartTimestamp()));
        ui.cleanEmpty.textContent = `${d} 之前沒有可清理的檔案。`;
      }
    }
  };

  const updateBackupView = () => {
    ui.archiveName.value = state.archiveName;
    updateSelectionUi();
    const progress = state.downloadProgress;
    if (!progress || !progress.total) {
      ui.backupProgress.classList.remove('is-active');
      ui.backupProgress.querySelector('span').style.width = '0%';
      if (ui.backupStatus) ui.backupStatus.textContent = '選取檔案後可開始備份。';
    } else {
      ui.backupProgress.classList.add('is-active');
      ui.backupProgress.querySelector('span').style.width = `${Math.min(100, (progress.doneCount / progress.total) * 100)}%`;
      if (ui.backupStatus) {
        const phase = progress.phase === 'packing' ? '正在建立 ZIP' : progress.phase === 'saving' ? '正在準備下載' : progress.phase === 'done' ? '備份完成' : progress.phase === 'error' ? '備份失敗' : progress.phase === 'cancelled' ? '備份已停止' : '正在下載';
        const err = progress.failed ? ` · 失敗 ${progress.failed}` : '';
        const cur = progress.current ? ` · ${progress.current}` : '';
        const codes = Array.isArray(progress.errors) && progress.errors.length ? ` · ${progress.errors.slice(0,3).map(([code,count]) => `${code} × ${count}`).join('、')}` : '';
        ui.backupStatus.textContent = `${phase} · ${progress.doneCount || 0}/${progress.total}${err}${cur}${codes}`;
      }
    }
    if (state.downloading) {
      ui.backupNow.classList.add('is-stop');
      ui.backupNow.innerHTML = `${iconSvg('close',16)}<span>停止備份</span>`;
    } else {
      ui.backupNow.classList.remove('is-stop');
      ui.backupNow.innerHTML = `${iconSvg('download',16)}<span>備份所選</span>`;
    }
  };

  const updateSettings = () => {
    ui.concurrency.value = String(state.concurrency);
    ui.autoSync.checked = !!state.autoSync;
    ui.indexInfo.textContent = state.accountReady ? `${state.files.size.toLocaleString('zh-TW')} 個索引項目 · 僅限目前帳號` : '正在辨識目前帳號';
    const p = state.syncProgress;
    ui.settingsSyncState.textContent = state.syncing ? `${p?.resumed ? '正在接續同步' : (state.files.size ? '正在檢查更新' : '正在同步檔案庫')}` : state.lastSyncAt ? `上次同步 ${fmtDateTime(state.lastSyncAt)}` : '尚未同步';
  };
  const updateAll = () => {
    if (!ui.root) return;
    updatePanelOpen();
    updateHeader();
    updateTabs();
    updateFileView();
    updateSelectionUi();
    updateCleanView();
    updateBackupView();
    updateSettings();
  };

  const scheduleSyncUi = () => {
    if (state.syncUiTimer) return;
    state.syncUiTimer = setTimeout(() => {
      state.syncUiTimer = null;
      updateHeader();
      if (state.panelOpen && state.activeTab === 'files') updateFileView();
      else if (state.panelOpen && state.activeTab === 'clean') updateCleanView();
      updateSettings();
    }, 300);
  };

  const startSync = automatic => {
    if (state.syncing || !isLibraryRoute()) return;
    if (!state.accountReady) {
      window.postMessage({ channel: CHANNEL, type:'PING_BRIDGE', payload:{} }, location.origin);
    window.postMessage({ channel: CHANNEL, type:'REQUEST_ACCOUNT', payload:{} }, location.origin);
      state.syncProgress = { error: state.bridgeReady ? '尚未識別目前 ChatGPT 帳號' : '尚未連接頁面橋接器' };
      updateHeader(); updateSettings();
      return;
    }
    state.syncing = true;
    state.syncRequestId = crypto.randomUUID();
    state.syncProgress = { requestId: state.syncRequestId, pages:0, found:0, resumed: !!state.syncCheckpoint };
    if (!automatic) state.panelOpen = true;
    updateAll();
    window.postMessage({ channel: CHANNEL, type:'SYNC_LIBRARY', payload:{
      requestId:state.syncRequestId,
      knownIds:[...state.files.keys()],
      resumeCheckpoint:state.syncCheckpoint,
      incremental:state.files.size > 0 && !state.syncCheckpoint
    } }, location.origin);
  };
  const stopSync = () => {
    if (!state.syncing) return;
    window.postMessage({ channel: CHANNEL, type:'STOP_SYNC', payload:{ requestId:state.syncRequestId } }, location.origin);
  };

  const startMetadataEnrichment = (datesOnly = false) => {
    if (state.enriching || state.syncing || !state.accountReady) return;
    const files = [...state.files.values()].filter(file => file.fileId && (datesOnly ? !timestamp(file.created) : (!timestamp(file.created) || !Number(file.size))));
    if (!files.length) return;
    state.enrichRequestId = crypto.randomUUID();
    state.enriching = true;
    state.enrichProgress = { requestId:state.enrichRequestId, total:files.length, done:0, failed:0 };
    updateHeader();
    window.postMessage({ channel:CHANNEL, type:'ENRICH_METADATA', payload:{ requestId:state.enrichRequestId, files:files.map(file => ({ id:file.id, fileId:file.fileId, name:file.name })), concurrency:2 } }, location.origin);
  };
  const stopMetadataEnrichment = () => {
    if (!state.enriching) return;
    window.postMessage({ channel:CHANNEL, type:'STOP_METADATA', payload:{ requestId:state.enrichRequestId } }, location.origin);
  };

  const mergeSyncBatch = files => {
    let changed = false;
    for (const raw of files || []) {
      const incoming = normalizeFile(raw);
      if (!isValidFile(incoming)) continue;
      const previous = state.files.get(incoming.id) || {};
      const mergedRaw = { ...previous, ...incoming };
      if (previous.size && !incoming.size) mergedRaw.size = previous.size;
      if (previous.created && !incoming.created) mergedRaw.created = previous.created;
      if (previous.updated && !incoming.updated) mergedRaw.updated = previous.updated;
      if (previous.thumbnailUrl && !incoming.thumbnailUrl) mergedRaw.thumbnailUrl = previous.thumbnailUrl;
      if (previous.fileId && !incoming.fileId) mergedRaw.fileId = previous.fileId;
      if (previous.libraryFileId && !incoming.libraryFileId) mergedRaw.libraryFileId = previous.libraryFileId;
      const merged = normalizeFile(mergedRaw);
      state.files.set(merged.id, merged);
      changed = true;
    }
    if (changed) {
      invalidateData();
      scheduleIndexSave();
      scheduleSyncUi();
    }
  };

  const requestResult = (type, payload, resultType, timeoutMs = 30000) => new Promise(resolve => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { resultResolvers.delete(requestId); resolve({ ok:false, status:0, error:'timeout' }); }, timeoutMs);
    resultResolvers.set(requestId, result => { clearTimeout(timer); resultResolvers.delete(requestId); resolve(result); });
    window.postMessage({ channel: CHANNEL, type, payload:{ ...payload, requestId } }, location.origin);
  });
  const resultResolvers = new Map();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const deleteChunkWithRetry = async files => {
    let delay = 800;
    let last = { ok:false, status:0, error:'unknown' };
    for (let attempt = 0; attempt < 5; attempt++) {
      last = await requestResult('DELETE_BATCH', { files }, 'DELETE_RESULT');
      if (last.ok) return last;
      if ([400,413,422].includes(last.status) && files.length > 1) {
        const mid = Math.ceil(files.length / 2);
        const a = await deleteChunkWithRetry(files.slice(0, mid));
        const b = await deleteChunkWithRetry(files.slice(mid));
        return { ok:a.ok && b.ok, status: a.ok ? b.status : a.status, split:true };
      }
      if (![0,408,409,425,429,500,502,503,504].includes(last.status)) return last;
      await sleep(delay + Math.random() * 300);
      delay = Math.min(delay * 2, 7000);
    }
    return last;
  };

  const bulkDelete = async () => {
    if (state.deleting) return;
    const files = selectedFiles().filter(hasDeletePair);
    if (!files.length) return;
    const bytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (!confirm(`確定要刪除 ${files.length.toLocaleString('zh-TW')} 個檔案？${bytes ? `\n容量約 ${fmtBytes(bytes)}` : ''}\n\n此操作會將檔案移出 ChatGPT 檔案庫。`)) return;

    state.deleting = true;
    state.deleteProgress = { total: files.length, done:0, failed:0 };
    updateSelectionUi();

    const chunkSize = state.concurrency === 1 ? 5 : state.concurrency === 2 ? 10 : 20;
    const chunks = [];
    for (let i = 0; i < files.length; i += chunkSize) chunks.push(files.slice(i, i + chunkSize));
    let cursor = 0;
    const failed = [];
    const failureCodes = new Map();
    const workers = Array.from({ length: Math.min(state.concurrency, chunks.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= chunks.length) return;
        const chunk = chunks[index];
        const result = await deleteChunkWithRetry(chunk);
        if (result.ok) {
          for (const file of chunk) { state.files.delete(file.id); state.selected.delete(file.id); }
        } else {
          failed.push(...chunk);
          const code = result.status ? `HTTP ${result.status}` : (result.error || '未知錯誤');
          failureCodes.set(code, (failureCodes.get(code)||0) + chunk.length);
          state.deleteProgress.failed += chunk.length;
        }
        state.deleteProgress.done += chunk.length;
        invalidateData();
        updateHeader();
        updateSelectionUi();
        renderVirtualRows();
        await sleep(0);
      }
    });
    await Promise.all(workers);
    state.deleting = false;
    state.lastSyncAt = Date.now();
    await saveIndex();
    updateAll();
    const failureSummary = [...failureCodes.entries()].map(([code,count]) => `${code} × ${count}`).join('、');
    alert(failed.length ? `刪除完成，但有 ${failed.length} 個檔案失敗。${failureSummary ? `\n${failureSummary}` : ''}\n失敗檔案會保留選取，可直接再次嘗試。` : `已刪除 ${files.length.toLocaleString('zh-TW')} 個檔案。`);
  };

  const startBackup = () => {
    if (state.downloading) {
      if (state.backupRequestId) window.postMessage({ channel:CHANNEL, type:'CANCEL_BACKUP', payload:{ requestId:state.backupRequestId } }, location.origin);
      return;
    }
    const files = selectedFiles().filter(file => file.fileId);
    if (!files.length) return;
    const archiveName = (state.archiveName || `chatgpt-library-${new Date().toISOString().slice(0,10)}`).replace(/[\/:*?"<>|]+/g, '_');
    state.backupRequestId = crypto.randomUUID();
    state.downloading = true;
    state.downloadProgress = { requestId:state.backupRequestId, total:files.length, doneCount:0, failed:0, phase:'download' };
    updateBackupView();
    updateSelectionUi();
    window.postMessage({ channel: CHANNEL, type:'PACK_BACKUP', payload:{ requestId:state.backupRequestId, files, archiveName, concurrency:3 } }, location.origin);
  };

  const clearCurrentIndex = async () => {
    if (!state.accountReady) return;
    if (!confirm('清除目前 ChatGPT 帳號的本機索引？\n這不會刪除 ChatGPT 裡的任何檔案。')) return;
    const keys = accountKeys();
    state.files.clear();
    state.selected.clear();
    state.lastSyncAt = 0;
    state.syncCheckpoint = null;
    invalidateData();
    if (keys) await chrome.storage.local.remove([keys.files, keys.sync, keys.checkpoint]);
    updateAll();
    startSync(false);
  };

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;
    if (msg.type === 'BRIDGE_READY') { state.bridgeReady = true; updateHeader(); updateSettings(); return; }
    if (msg.type === 'LIBRARY_SOURCE_READY') { state.librarySource = { method: msg.payload?.method || '', url: msg.payload?.url || '', count: msg.payload?.count || 0 }; updateSettings(); return; }
    if (msg.type === 'ACCOUNT_CONTEXT') { switchAccount(msg.payload?.identifier); return; }
    if (msg.type === 'SYNC_BATCH' && msg.payload?.requestId === state.syncRequestId) { mergeSyncBatch(msg.payload.files); return; }
    if (msg.type === 'SYNC_PROGRESS' && msg.payload?.requestId === state.syncRequestId) {
      state.syncProgress = { ...(state.syncProgress || {}), ...msg.payload };
      if (msg.payload.checkpoint) state.syncCheckpoint = msg.payload.checkpoint;
      if (msg.payload.done) {
        state.syncing = false;
        if (!msg.payload.error && !msg.payload.stopped) { state.lastSyncAt = Date.now(); state.syncCheckpoint = null; }
        clearTimeout(state.persistTimer);
        state.persistTimer = null;
        saveIndex();
        updateAll();
        if (!msg.payload.error && !msg.payload.stopped) setTimeout(startMetadataEnrichment, 350);
      } else { scheduleIndexSave(500); scheduleSyncUi(); }
      return;
    }
    if (msg.type === 'METADATA_BATCH' && msg.payload?.requestId === state.enrichRequestId) {
      mergeSyncBatch(msg.payload.files || []);
      return;
    }
    if (msg.type === 'METADATA_PROGRESS' && msg.payload?.requestId === state.enrichRequestId) {
      state.enrichProgress = { ...(state.enrichProgress || {}), ...msg.payload };
      if (msg.payload.done) {
        state.enriching = false;
        state.enrichRequestId = '';
        saveIndex();
        updateAll();
      } else {
        updateHeader();
      }
      return;
    }
    if (msg.type === 'PREVIEW_RESULT') {
      previewResolvers.get(msg.payload?.requestId)?.(msg.payload);
      return;
    }
    if (msg.type === 'DELETE_RESULT') {
      resultResolvers.get(msg.payload?.requestId)?.(msg.payload);
      return;
    }
    if (msg.type === 'BACKUP_PROGRESS') {
      if (state.backupRequestId && msg.payload?.requestId && msg.payload.requestId !== state.backupRequestId) return;
      state.downloadProgress = { ...(state.downloadProgress || {}), ...msg.payload };
      if (msg.payload?.done) { state.downloading = false; state.backupRequestId = ''; }
      updateBackupView();
      updateSelectionUi();
    }
  });

  const init = async () => {
    await loadUi();
    await mount();
    window.postMessage({ channel: CHANNEL, type:'REQUEST_ACCOUNT', payload:{} }, location.origin);
    state.routeTimer = setInterval(applyRouteVisibility, 900);
    window.addEventListener('focus', () => window.postMessage({ channel:CHANNEL, type:'REQUEST_ACCOUNT', payload:{} }, location.origin));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) window.postMessage({ channel:CHANNEL, type:'REQUEST_ACCOUNT', payload:{} }, location.origin); });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();
