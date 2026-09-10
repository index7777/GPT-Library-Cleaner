(() => {
  if (window.__LC_PAGE_BRIDGE_V220__) return;
  window.__LC_PAGE_BRIDGE_V220__ = true;

  const CHANNEL = 'LC_BRIDGE_V240';
  const post = (type, payload = {}) => window.postMessage({ channel: CHANNEL, type, payload }, location.origin);
  const originalFetch = window.fetch.bind(window);
  const syncControllers = new Map();
  const objectUrls = new Set();
  let learnedLibrarySource = null;
  let learnedLibraryFirstPage = null;
  let learnedDeleteHeaders = null;
  const discoveryUntil = Date.now() + 12000;

  const isLibraryRequest = url => {
    try {
      const u = new URL(String(url || ''), location.href);
      return u.origin === location.origin && /\/backend-api\/files\/library(?:\/nodes)?(?:\?|$)/.test(u.href) && !/delete-batch/.test(u.href);
    } catch { return false; }
  };

  const normalizeLibrarySource = (url, method, headers, body) => {
    let outUrl = String(url || '');
    let outBody = body == null ? null : String(body);
    try {
      const u = new URL(outUrl, location.href);
      if (method === 'GET') {
        for (const k of ['cursor','after','page_cursor','pageCursor','next_cursor','offset','page']) u.searchParams.delete(k);
        outUrl = u.href;
      }
    } catch {}
    if (method === 'POST' && outBody) {
      try {
        const obj = JSON.parse(outBody);
        const clear = (node, depth=0) => {
          if (!node || typeof node !== 'object' || depth > 8) return;
          for (const k of Object.keys(node)) {
            if (['cursor','after','page_cursor','pageCursor','next_cursor','nextCursor','continuation_token','continuationToken'].includes(k)) node[k] = null;
            else if (k === 'offset') node[k] = 0;
            else if (k === 'page') node[k] = 1;
            else clear(node[k], depth + 1);
          }
        };
        clear(obj); outBody = JSON.stringify(obj);
      } catch {}
    }
    return { url: outUrl, method, headers: cleanHeaders(headers), body: outBody };
  };

  const safeJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const cleanHeaders = src => {
    const out = {};
    try {
      new Headers(src || {}).forEach((value, key) => {
        const k = String(key).toLowerCase();
        if (!['content-length','host','cookie','origin','referer','sec-fetch-site','sec-fetch-mode','sec-fetch-dest'].includes(k)) out[k] = value;
      });
    } catch {}
    return out;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const libId = v => /^libfile[_-]/i.test(String(v || '')) ? String(v) : '';
  const fileId = v => /^file[_-]/i.test(String(v || '')) ? String(v) : '';
  const validFileId = id => /^(libfile[_-]|file[_-])/i.test(String(id || ''));
  const looksLikeFilename = name => /\.[a-z0-9]{1,12}$/i.test(String(name || '').trim());
  const looksLikeMime = mime => /^[-\w.+]+\/[-\w.+]+$/i.test(String(mime || '').trim());

  const firstStringUrl = value => {
    if (!value) return '';
    if (typeof value === 'string' && /^(https?:|blob:|data:image\/)/i.test(value)) return value;
    if (typeof value === 'object') {
      for (const k of ['url','src','download_url','downloadUrl','thumbnail_url','thumbnailUrl','preview_url','previewUrl']) {
        if (typeof value[k] === 'string' && /^(https?:|blob:|data:image\/)/i.test(value[k])) return value[k];
      }
    }
    return '';
  };

  const deepValue = (node, keys, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 7) return undefined;
    for (const key of keys) {
      if (node[key] !== undefined && node[key] !== null && node[key] !== '') return node[key];
    }
    for (const preferred of ['file','asset','metadata','attributes','resource','node','properties','details','content','data','payload','file_info','fileInfo','attachment','blob','storage','value']) {
      const child = node[preferred];
      if (child && typeof child === 'object') {
        const found = deepValue(child, keys, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  const deepHeuristicValue = (node, kind, depth = 0, seen = new Set()) => {
    if (!node || typeof node !== 'object' || depth > 9 || seen.has(node)) return undefined;
    seen.add(node);
    if (!Array.isArray(node)) {
      for (const [rawKey, value] of Object.entries(node)) {
        const key = String(rawKey).toLowerCase().replace(/[-\s]/g, '_');
        if (value == null || value === '') continue;
        if (kind === 'created' && /^(created|creation|create|uploaded|upload|inserted|date_created|added)(_|$)/.test(key) && /(at|time|date|timestamp|ts)$/.test(key)) return value;
        if (kind === 'size' && /(size|bytes|length)/.test(key) && typeof value !== 'object') {
          const n = Number(value); if (Number.isFinite(n) && n > 0) return n;
        }
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') { const found = deepHeuristicValue(value, kind, depth + 1, seen); if (found !== undefined) return found; }
    }
    return undefined;
  };

  const asPlausibleDate = value => {
    if (value == null || value === '') return null;
    let d = null;
    if (typeof value === 'number' || /^\d{9,16}$/.test(String(value))) {
      let n = Number(value);
      if (!Number.isFinite(n)) return null;
      if (n < 1e11) n *= 1000;
      d = new Date(n);
    } else if (typeof value === 'string') {
      const t = Date.parse(value);
      if (Number.isFinite(t)) d = new Date(t);
    }
    if (!d || Number.isNaN(d.getTime())) return null;
    const min = Date.UTC(2015,0,1), max = Date.now() + 366*86400000;
    if (d.getTime() < min || d.getTime() > max) return null;
    return { iso:d.toISOString(), timestamp:d.getTime() };
  };

  const collectDateCandidates = (node, path='root', out=[], depth=0, seen=new Set()) => {
    if (node == null || depth > 10 || out.length > 250) return out;
    if (typeof node !== 'object') return out;
    if (seen.has(node)) return out; seen.add(node);
    const entries = Array.isArray(node) ? node.entries() : Object.entries(node);
    for (const [rawKey, value] of entries) {
      const key = String(rawKey);
      const childPath = Array.isArray(node) ? `${path}[${key}]` : `${path}.${key}`;
      if (value && typeof value === 'object') { collectDateCandidates(value, childPath, out, depth+1, seen); continue; }
      const parsed = asPlausibleDate(value);
      if (!parsed) continue;
      const k = childPath.toLowerCase();
      let score = 5;
      if (/(created|creation|date_created|create_time)/.test(k)) score += 120;
      else if (/(uploaded|upload_time|inserted|added)/.test(k)) score += 105;
      else if (/(timestamp|datetime|date|time)/.test(k)) score += 55;
      if (/(updated|modified|last_modified)/.test(k)) score -= 20;
      if (/(expire|expiry|expires|token|signed|ttl)/.test(k)) score -= 150;
      out.push({ path:childPath, value, iso:parsed.iso, timestamp:parsed.timestamp, score });
    }
    return out;
  };
  const bestDateCandidate = node => collectDateCandidates(node).sort((a,b) => b.score-a.score || a.timestamp-b.timestamp)[0] || null;

  const findRawNodeForFile = (node, ids, depth=0, seen=new Set()) => {
    if (!node || typeof node !== 'object' || depth > 10 || seen.has(node)) return null;
    seen.add(node);
    if (!Array.isArray(node)) {
      try {
        const values = Object.values(node).map(v => typeof v === 'string' ? v : '').filter(Boolean);
        if (ids.some(id => id && values.includes(id))) return node;
      } catch {}
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') { const found = findRawNodeForFile(value, ids, depth+1, seen); if (found) return found; }
    }
    return null;
  };

  const extractCandidate = node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const rawId = deepValue(node, ['id','library_file_id','libraryFileId','file_id','fileId']);
    const libraryFileId = libId(deepValue(node, ['library_file_id','libraryFileId'])) || libId(node.id);
    const nestedFileId = deepValue(node, ['file_id','fileId']);
    const underlyingFileId = fileId(nestedFileId) || (libraryFileId ? fileId(deepValue(node.file || {}, ['id'])) : fileId(node.id));
    const id = libraryFileId || underlyingFileId || rawId;
    const name = deepValue(node, ['name','filename','file_name','fileName','display_name','displayName','original_name','originalName','title']);
    const size = deepValue(node, ['size','bytes','byte_size','byteSize','size_bytes','sizeBytes','byte_count','byteCount','file_size','fileSize','file_size_bytes','fileSizeBytes','file_bytes','fileBytes','content_size','contentSize','content_length','contentLength','content_length_bytes','contentLengthBytes','storage_size','storageSize','length_bytes','lengthBytes']) ?? deepHeuristicValue(node, 'size');
    const mime = deepValue(node, ['mime_type','mimeType','content_type','contentType','media_type','mediaType','mimetype']);
    const created = deepValue(node, ['record_creation_time','recordCreationTime','file_upload_time','fileUploadTime','created_at','createdAt','created','created_time','createdTime','creation_time','creationTime','creation_timestamp','creationTimestamp','create_time','createTime','created_ts','createdTs','created_at_ms','createdAtMs','uploaded_at','uploadedAt','upload_time','uploadTime','upload_date','uploadDate','date_created','dateCreated','inserted_at','insertedAt','timestamp','timestamp_ms','timestampMs']) ?? deepHeuristicValue(node, 'created') ?? bestDateCandidate(node)?.iso;
    const updated = deepValue(node, ['updated_at','updatedAt','updated','modified_at','modifiedAt','modified','last_modified','lastModified']);
    const thumbRaw = deepValue(node, ['thumbnail_url','thumbnailUrl','thumbnail','preview_url','previewUrl','preview','image_url','imageUrl']);
    const thumbnailUrl = firstStringUrl(thumbRaw);
    const strongSignal = looksLikeMime(mime) || Number(size) > 0 || looksLikeFilename(name);
    if (!id || !validFileId(id) || !name || !strongSignal) return null;
    return {
      id: String(libraryFileId || underlyingFileId || id),
      libraryFileId,
      fileId: underlyingFileId,
      name: String(name),
      size: Number(size) || 0,
      mime: mime ? String(mime) : '',
      created: created || null,
      updated: updated || null,
      thumbnailUrl: thumbnailUrl || ''
    };
  };

  const extractCandidates = (node, out = [], depth = 0) => {
    if (depth > 10 || node == null) return out;
    if (Array.isArray(node)) {
      for (const item of node) extractCandidates(item, out, depth + 1);
      return out;
    }
    if (typeof node !== 'object') return out;
    const candidate = extractCandidate(node);
    if (candidate) out.push(candidate);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') extractCandidates(value, out, depth + 1);
    }
    return out;
  };

  const mergeCandidate = (base = {}, incoming = {}) => {
    const out = { ...base };
    for (const [key, value] of Object.entries(incoming || {})) {
      const empty = value == null || value === '' || value === 0;
      if (!empty || out[key] == null || out[key] === '' || out[key] === 0) out[key] = value;
    }
    if (base.size && !incoming.size) out.size = base.size;
    if (base.created && !incoming.created) out.created = base.created;
    if (base.updated && !incoming.updated) out.updated = base.updated;
    if (base.thumbnailUrl && !incoming.thumbnailUrl) out.thumbnailUrl = base.thumbnailUrl;
    if (base.libraryFileId && !incoming.libraryFileId) out.libraryFileId = base.libraryFileId;
    if (base.fileId && !incoming.fileId) out.fileId = base.fileId;
    return out;
  };
  const uniqueCandidates = list => {
    const map = new Map();
    for (const file of list || []) {
      const key = file.libraryFileId || file.fileId || file.id;
      if (!key) continue;
      map.set(key, mergeCandidate(map.get(key), file));
    }
    return [...map.values()];
  };

  const deepPagination = (node, out = {}, depth = 0) => {
    if (depth > 9 || !node || typeof node !== 'object') return out;
    if (!Array.isArray(node)) {
      for (const [rawKey, value] of Object.entries(node)) {
        const key = rawKey.toLowerCase();
        if (out.hasMore === undefined && ['has_more','hasmore','has_next','hasnext'].includes(key)) out.hasMore = value;
        if (out.nextCursor === undefined && ['next_cursor','nextcursor','next_page_cursor','nextpagecursor','continuation_token','continuationtoken','next_token','nexttoken','after'].includes(key)) out.nextCursor = value;
        if (out.cursor === undefined && ['cursor','current_cursor','currentcursor'].includes(key)) out.cursor = value;
        if (out.next === undefined && ['next','next_url','nexturl','next_page','nextpage'].includes(key)) out.next = value;
        if (out.offset === undefined && ['offset','current_offset','currentoffset'].includes(key)) out.offset = value;
        if (out.limit === undefined && ['limit','page_size','pagesize','per_page','perpage'].includes(key)) out.limit = value;
        if (out.page === undefined && ['page','current_page','currentpage'].includes(key)) out.page = value;
        if (out.total === undefined && ['total','total_count','totalcount'].includes(key)) out.total = value;
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') deepPagination(value, out, depth + 1);
    }
    return out;
  };

  const paginationInfo = (json, currentUrl, candidateCount) => {
    const raw = deepPagination(json, {});
    const info = {
      hasMore: raw.hasMore,
      nextCursor: raw.nextCursor,
      cursor: raw.cursor,
      next: raw.next,
      offset: Number(raw.offset),
      limit: Number(raw.limit),
      page: Number(raw.page),
      total: Number(raw.total)
    };
    for (const key of ['offset','limit','page','total']) if (!Number.isFinite(info[key])) info[key] = undefined;
    try {
      const url = new URL(currentUrl, location.href);
      if (info.limit == null) {
        for (const key of ['limit','page_size','pageSize','per_page']) {
          if (url.searchParams.has(key)) {
            const n = Number(url.searchParams.get(key));
            if (Number.isFinite(n)) info.limit = n;
          }
        }
      }
      const requestCursor = url.searchParams.get('cursor');
      if ((info.nextCursor == null || info.nextCursor === '') && info.cursor != null && String(info.cursor) !== String(requestCursor || '')) {
        info.nextCursor = info.cursor;
      }
    } catch {}
    if (info.hasMore === undefined && info.nextCursor != null && info.nextCursor !== '') info.hasMore = true;
    if (info.hasMore === undefined && info.total != null && info.total > candidateCount) info.hasMore = true;
    return info;
  };

  const nextGetUrl = (currentUrl, page) => {
    if (page.hasMore === false) return null;
    if (typeof page.next === 'string' && page.next && page.next !== currentUrl) {
      try { return new URL(page.next, currentUrl).href; } catch {}
    }
    const url = new URL(currentUrl, location.href);
    if (page.nextCursor != null && String(page.nextCursor) !== '') {
      const key = ['cursor','after','page_cursor','next_cursor'].find(k => url.searchParams.has(k)) || 'cursor';
      url.searchParams.set(key, String(page.nextCursor));
      return url.href;
    }
    const limit = page.limit || Number(url.searchParams.get('limit')) || Number(url.searchParams.get('page_size'));
    if ((page.offset != null || url.searchParams.has('offset')) && page.hasMore !== false) {
      const current = page.offset != null ? page.offset : Number(url.searchParams.get('offset')) || 0;
      url.searchParams.set('offset', String(current + (limit || 50)));
      return url.href;
    }
    if ((page.page != null || url.searchParams.has('page')) && page.hasMore !== false) {
      const current = page.page != null ? page.page : Number(url.searchParams.get('page')) || 1;
      url.searchParams.set('page', String(current + 1));
      return url.href;
    }
    return null;
  };

  const setDeepValue = (node, names, value, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return false;
    for (const key of Object.keys(node)) {
      if (names.includes(key)) { node[key] = value; return true; }
    }
    for (const valueNode of Object.values(node)) {
      if (valueNode && typeof valueNode === 'object' && setDeepValue(valueNode, names, value, depth + 1)) return true;
    }
    return false;
  };

  const nextPostBody = (bodyText, page, candidateCount) => {
    let body;
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = {}; }
    if (page.hasMore === false) return null;
    if (page.nextCursor != null && String(page.nextCursor) !== '') {
      if (!setDeepValue(body, ['cursor','after','page_cursor','pageCursor','next_cursor','nextCursor'], page.nextCursor)) body.cursor = page.nextCursor;
      return JSON.stringify(body);
    }
    const limit = page.limit || candidateCount || 50;
    if (page.offset != null && page.hasMore !== false) {
      const next = Number(page.offset) + Number(limit);
      if (!setDeepValue(body, ['offset','current_offset','currentOffset'], next)) body.offset = next;
      return JSON.stringify(body);
    }
    if (page.page != null && page.hasMore !== false) {
      const next = Number(page.page) + 1;
      if (!setDeepValue(body, ['page','current_page','currentPage'], next)) body.page = next;
      return JSON.stringify(body);
    }
    return null;
  };

  const findAccountIdentifier = json => {
    const direct = [
      json?.user?.id, json?.user?.sub, json?.user?.email,
      json?.account?.id, json?.account?.account_id, json?.account?.email,
      json?.id, json?.user_id, json?.userId, json?.sub, json?.email
    ].find(v => v != null && String(v).trim());
    if (direct) return String(direct);
    const seen = new Set();
    const walk = (node, depth=0) => {
      if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return '';
      seen.add(node);
      for (const [k,v] of Object.entries(node)) {
        if (v == null || typeof v === 'object') continue;
        const key = String(k).toLowerCase();
        if (['user_id','userid','account_id','accountid','sub','email'].includes(key) && String(v).trim()) return String(v);
      }
      for (const v of Object.values(node)) { const hit = walk(v, depth+1); if (hit) return hit; }
      return '';
    };
    return walk(json);
  };

  const detectAccount = async () => {
    for (const url of ['/backend-api/me', '/api/auth/session']) {
      try {
        const response = await originalFetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
        if (!response.ok) continue;
        const json = safeJson(await response.text());
        const identifier = findAccountIdentifier(json);
        if (identifier) { post('ACCOUNT_CONTEXT', { identifier }); return; }
      } catch {}
    }
    post('ACCOUNT_CONTEXT', { identifier: '' });
  };

  const openLibrarySource = async signal => {
    for (let i = 0; i < 8 && !learnedLibrarySource && !signal?.aborted; i++) await sleep(100);

    if (learnedLibrarySource && learnedLibraryFirstPage?.json && learnedLibraryFirstPage?.candidates?.length) {
      post('LIBRARY_SOURCE_READY', { method: learnedLibrarySource.method, url: learnedLibrarySource.url, count: learnedLibraryFirstPage.candidates.length });
      return { ...learnedLibrarySource, json: learnedLibraryFirstPage.json, candidates: learnedLibraryFirstPage.candidates };
    }

    const sources = [];
    if (learnedLibrarySource) sources.push(learnedLibrarySource);
    if (!sources.length) {
      for (let i = 0; i < 22 && !learnedLibrarySource && !signal?.aborted; i++) await sleep(100);
      if (learnedLibrarySource) sources.push(learnedLibrarySource);
    }

    const tried = new Set();
    let best = null;
    for (const source of sources) {
      const key = `${source.method}|${source.url}|${source.body || ''}`;
      if (tried.has(key)) continue;
      tried.add(key);
      try {
        const options = { method: source.method, credentials: 'include', headers: cleanHeaders(source.headers || { accept:'application/json' }), signal };
        if (source.body != null && source.method !== 'GET') options.body = source.body;
        const response = await originalFetch(source.url, options);
        if (!response.ok) continue;
        const json = safeJson(await response.text());
        if (!json) continue;
        const candidates = uniqueCandidates(extractCandidates(json));
        if (!candidates.length) continue;
        const normalized = normalizeLibrarySource(source.url, source.method, source.headers, source.body);
        const page = paginationInfo(json, normalized.url, candidates.length);
        const paginates = (page.nextCursor != null && String(page.nextCursor) !== '') || page.hasMore === true || page.next || page.offset != null || page.page != null || (page.total != null && page.total > candidates.length);
        const score = (paginates ? 100000 : 0) + (learnedLibrarySource && source === learnedLibrarySource ? 1000 : 0) + candidates.length;
        if (!best || score > best.score) best = { score, source: normalized, json, candidates };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }
    }
    if (best) {
      learnedLibrarySource = best.source;
      post('LIBRARY_SOURCE_READY', { method: best.source.method, url: best.source.url, count: best.candidates.length });
      return { ...best.source, json: best.json, candidates: best.candidates };
    }
    throw new Error('尚未取得可分頁的檔案庫資料來源，請重新整理檔案庫後再同步');
  };

  const runFullSync = async payload => {
    const requestId = payload?.requestId;
    const knownIds = new Set(payload?.knownIds || []);
    const incremental = !!payload?.incremental;
    const resumeCheckpoint = payload?.resumeCheckpoint || null;
    const abort = new AbortController();
    syncControllers.set(requestId, abort);
    let pages = 0;
    let found = 0;
    let pending = [];
    let lastProgressAt = 0;
    const seenIds = new Set();
    const seenRequests = new Set();
    let noNewStreak = 0;
    let noUnknownStreak = 0;

    const emitBatch = force => {
      if (!pending.length) return;
      if (!force && pending.length < 20) return;
      post('SYNC_BATCH', { requestId, files: uniqueCandidates(pending) });
      pending = [];
    };
    const emitProgress = (extra = {}, force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressAt < 350) return;
      lastProgressAt = now;
      post('SYNC_PROGRESS', { requestId, pages, found, ...extra });
    };

    try {
      const source = await openLibrarySource(abort.signal);
      let url = resumeCheckpoint?.url || source.url;
      let method = resumeCheckpoint?.method || source.method;
      let body = resumeCheckpoint?.body !== undefined ? resumeCheckpoint.body : source.body;
      const sourceHeaders = cleanHeaders(source.headers || {});
      let firstPage = resumeCheckpoint ? null : { json: source.json, candidates: source.candidates };
      if (resumeCheckpoint) emitProgress({ resumed:true, checkpoint:resumeCheckpoint }, true);

      while (!abort.signal.aborted && pages < 2000) {
        let json, candidates;
        if (firstPage) {
          ({ json, candidates } = firstPage);
          firstPage = null;
        } else {
          const signature = `${method}|${url}|${body || ''}`;
          if (seenRequests.has(signature)) break;
          seenRequests.add(signature);
          const options = { method, credentials: 'include', headers: { ...sourceHeaders }, signal: abort.signal };
          if (!Object.keys(options.headers).some(k => k.toLowerCase() === 'accept')) options.headers.accept = 'application/json';
          if (method === 'POST' && !Object.keys(options.headers).some(k => k.toLowerCase() === 'content-type')) options.headers['content-type'] = 'application/json';
          if (method === 'POST' && body != null) options.body = body;
          const response = await originalFetch(url, options);
          if (!response.ok) throw new Error(`同步失敗：HTTP ${response.status}`);
          json = safeJson(await response.text());
          if (!json) throw new Error('同步回應不是 JSON');
          candidates = uniqueCandidates(extractCandidates(json));
        }

        let newOnPage = 0;
        let unknownOnPage = 0;
        for (const file of candidates) {
          const key = file.libraryFileId || file.fileId || file.id;
          if (!key || seenIds.has(key)) continue;
          seenIds.add(key);
          pending.push(file);
          newOnPage++;
          if (!knownIds.has(key)) unknownOnPage++;
        }
        pages++;
        found = seenIds.size;
        emitBatch(false);
        const page = paginationInfo(json, url, candidates.length);
        let nextUrl = url, nextBody = body;
        if (method === 'GET') nextUrl = nextGetUrl(url, page);
        else nextBody = nextPostBody(body, page, candidates.length);
        const checkpoint = (method === 'GET' && nextUrl && nextUrl !== url) || (method !== 'GET' && nextBody && nextBody !== body)
          ? { url: method === 'GET' ? nextUrl : url, method, body: method === 'GET' ? body : nextBody, pages, found }
          : null;
        emitProgress({ pageItems: candidates.length, newOnPage, unknownOnPage, total: page.total, hasMore: page.hasMore, sourceUrl: url, sourceMethod: method, checkpoint });

        if (!candidates.length || page.hasMore === false) break;
        noNewStreak = newOnPage === 0 ? noNewStreak + 1 : 0;
        noUnknownStreak = unknownOnPage === 0 ? noUnknownStreak + 1 : 0;
        if (noNewStreak >= 2) break;
        if (incremental && noUnknownStreak >= 2) break;
        if (method === 'GET') {
          if (!nextUrl || nextUrl === url) break;
          url = nextUrl;
        } else {
          if (!nextBody || nextBody === body) break;
          body = nextBody;
        }
        await sleep(140);
      }

      emitBatch(true);
      emitProgress({ done: true, stopped: abort.signal.aborted }, true);
    } catch (error) {
      emitBatch(true);
      if (error?.name === 'AbortError') emitProgress({ done: true, stopped: true }, true);
      else emitProgress({ done: true, error: String(error?.message || error) }, true);
    } finally {
      syncControllers.delete(requestId);
    }
  };

  const deleteBatch = async payload => {
    const { requestId, files } = payload || {};
    try {
      const body = JSON.stringify({ files: (files || []).map(file => ({ library_file_id: file.libraryFileId, file_id: file.fileId })) });
      const authHeaders = cleanHeaders(learnedDeleteHeaders || learnedLibrarySource?.headers || {});
      authHeaders.accept = authHeaders.accept || 'application/json';
      authHeaders['content-type'] = 'application/json';
      const response = await originalFetch(`${location.origin}/backend-api/files/library/files/delete-batch`, {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders,
        body
      });
      let text = '';
      try { text = await response.text(); } catch {}
      post('DELETE_RESULT', { requestId, ok: response.ok, status: response.status, count: files?.length || 0, bodyPreview: text.slice(0, 300) });
    } catch (error) {
      post('DELETE_RESULT', { requestId, ok: false, status: 0, count: files?.length || 0, error: String(error) });
    }
  };

  const currentAuthHeaders = async (accept = '*/*', forceRefresh = false) => {
    const headers = cleanHeaders(learnedLibrarySource?.headers || learnedDeleteHeaders || {});
    headers.accept = accept;
    if (!headers.authorization || forceRefresh || !headers['chatgpt-account-id']) {
      try {
        const response = await originalFetch('/api/auth/session', { credentials:'include', cache:'no-store', headers:{ accept:'application/json' } });
        if (response.ok) {
          const json = safeJson(await response.text());
          const token = json?.accessToken || json?.access_token;
          if (token) headers.authorization = `Bearer ${token}`;
          const accountId = deepValue(json, ['account_id','accountId','active_account_id','activeAccountId','workspace_id','workspaceId']);
          if (accountId && !headers['chatgpt-account-id']) headers['chatgpt-account-id'] = String(accountId);
        }
      } catch {}
    }
    return headers;
  };

  const fetchAuthenticatedContent = async (url, signal, timeoutMs = 20000) => {
    const resolved = new URL(String(url || ''), location.href);
    if (resolved.origin !== location.origin) return fetchWithTimeout(resolved.href, { credentials:'omit' }, timeoutMs, signal);
    let headers = await currentAuthHeaders('*/*');
    let response = await fetchWithTimeout(resolved.href, { credentials:'include', headers }, timeoutMs, signal);
    if ([401,403].includes(response.status) && !signal?.aborted) {
      headers = await currentAuthHeaders('*/*', true);
      response = await fetchWithTimeout(resolved.href, { credentials:'include', headers, cache:'no-store' }, timeoutMs, signal);
    }
    return response;
  };

  const enrichMetadata = async payload => {
    const files = payload?.files || [];
    const requestId = payload?.requestId || crypto.randomUUID();
    const controller = new AbortController();
    metadataControllers.set(requestId, controller);
    const total = files.length;
    let cursor = 0, done = 0, failed = 0;
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      post('METADATA_BATCH', { requestId, files:batch });
      batch = [];
    };
    const report = extra => post('METADATA_PROGRESS', { requestId, total, done, failed, ...extra });
    const worker = async () => {
      while (!controller.signal.aborted) {
        const i = cursor++;
        if (i >= total) return;
        const file = files[i];
        try {
          let headers = await currentAuthHeaders('application/json');
          let response = await fetchWithTimeout(`/backend-api/files/${encodeURIComponent(file.fileId)}`, { credentials:'include', headers }, 12000, controller.signal);
          if ([401,403].includes(response.status)) { headers = await currentAuthHeaders('application/json', true); response = await fetchWithTimeout(`/backend-api/files/${encodeURIComponent(file.fileId)}`, { credentials:'include', headers, cache:'no-store' }, 12000, controller.signal); }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const json = safeJson(await response.text());
          if (!json) throw new Error('invalid metadata');
          const created = deepValue(json, ['creation_time','creationTime','created_at','createdAt','created','uploaded_at','uploadedAt','timestamp']) ?? deepHeuristicValue(json, 'created') ?? bestDateCandidate(json)?.iso;
          const size = deepValue(json, ['file_size_bytes','fileSizeBytes','size_bytes','sizeBytes','file_size','fileSize','size','bytes']) ?? deepHeuristicValue(json, 'size');
          const mime = deepValue(json, ['mime_type','mimeType','content_type','contentType']);
          const name = deepValue(json, ['file_name','fileName','filename','name']);
          batch.push({ id:file.id, fileId:file.fileId, name:name || file.name, created:created || null, size:Number(size)||0, mime:mime || '' });
        } catch (error) {
          if (controller.signal.aborted) return;
          failed++;
        }
        done++;
        if (batch.length >= 20) flush();
        if (done % 10 === 0) report({});
        await sleep(80);
      }
    };
    try {
      report({});
      await Promise.all(Array.from({ length:Math.min(Math.max(1, Number(payload?.concurrency)||2), total || 1) }, worker));
      flush();
      report({ done:true, stopped:controller.signal.aborted });
    } finally {
      metadataControllers.delete(requestId);
    }
  };

  const resolvePreview = async payload => {
    const { requestId, fileId: rawFileId } = payload || {};
    const id = encodeURIComponent(rawFileId || '');
    if (!id) { post('PREVIEW_RESULT', { requestId, ok:false }); return; }
    const candidates = [`/backend-api/files/download/${id}?inline=true`, `/backend-api/files/${id}/download`];
    let lastError = '';
    for (const url of candidates) {
      try {
        const headers = await currentAuthHeaders('application/json,image/*,*/*');
        const response = await originalFetch(url, { credentials:'include', headers });
        if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
        const type = response.headers.get('content-type') || '';
        if (type.includes('json')) {
          const json = safeJson(await response.text());
          const signed = json?.download_url || json?.downloadUrl || json?.url;
          if (!signed) { lastError='missing-url'; continue; }
          const image = await fetchAuthenticatedContent(signed, null, 15000);
          if (!image.ok) { lastError = `preview HTTP ${image.status}`; continue; }
          const blob = await image.blob();
          const objectUrl = URL.createObjectURL(blob);
          objectUrls.add(objectUrl);
          post('PREVIEW_RESULT', { requestId, ok:true, url:objectUrl, objectUrl:true });
          return;
        }
        if (type.startsWith('image/')) {
          const blob = await response.blob();
          const objectUrl = URL.createObjectURL(blob);
          objectUrls.add(objectUrl);
          post('PREVIEW_RESULT', { requestId, ok:true, url:objectUrl, objectUrl:true });
          return;
        }
        lastError = `unsupported:${type}`;
      } catch (error) { lastError = String(error?.message || error); }
    }
    post('PREVIEW_RESULT', { requestId, ok:false, error:lastError });
  };

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();
  const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const u16 = v => new Uint8Array([v & 255, (v >>> 8) & 255]);
  const u32 = v => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  const concat = parts => { const total = parts.reduce((n, part) => n + part.length, 0); const out = new Uint8Array(total); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; };
  const dosDateTime = () => { const d = new Date(); const year = Math.max(1980, d.getFullYear()); return { time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff }; };
  const cleanName = name => String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, '_').slice(0, 180) || 'file';
  const splitExt = name => { const match = String(name).match(/^(.*?)(\.[^.]{1,12})$/); return match ? [match[1], match[2]] : [String(name), '']; };
  const archiveEntryName = (file, index, mode, prefix) => {
    const original = cleanName(file.name || file.fileId || `file-${index + 1}`);
    const seq = String(index + 1).padStart(3, '0');
    if (mode === 'numbered') return `${seq}_${original}`;
    if (mode === 'prefix') { const [, ext] = splitExt(original); return `${cleanName(prefix || 'ChatGPT')}_${seq}${ext}`; }
    return original;
  };
  const uniqueName = (name, used) => { let out = name, n = 2; const [base, ext] = splitExt(name); while (used.has(out.toLowerCase())) out = `${base} (${n++})${ext}`; used.add(out.toLowerCase()); return out; };
  const backupControllers = new Map();
  const metadataControllers = new Map();
  const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000, parentSignal) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const abortParent = () => controller.abort('cancelled');
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort('cancelled');
      else parentSignal.addEventListener('abort', abortParent, { once:true });
    }
    try { return await originalFetch(url, { ...options, signal: controller.signal }); }
    finally {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortParent);
    }
  };

  const fetchDownloadBlob = async (file, signal) => {
    const id = encodeURIComponent(file.fileId || '');
    const endpoints = [`/backend-api/files/download/${id}?inline=false`, `/backend-api/files/${id}/download`];
    let last = '';
    const authHeaders = await currentAuthHeaders('application/json,*/*');
    for (const url of endpoints) {
      if (signal?.aborted) throw new Error('已取消');
      try {
        const response = await fetchWithTimeout(url, { credentials:'include', headers:authHeaders }, 12000, signal);
        if (!response.ok) { last = `HTTP ${response.status}`; continue; }
        const type = response.headers.get('content-type') || '';
        if (!type.includes('json')) return await response.blob();
        const json = safeJson(await response.text());
        const signed = json?.download_url || json?.downloadUrl || json?.url;
        if (!signed) { last = 'missing download url'; continue; }
        const download = await fetchAuthenticatedContent(signed, signal, 20000);
        if (!download.ok) { last = `download HTTP ${download.status}`; continue; }
        return await download.blob();
      } catch (error) {
        if (signal?.aborted) throw new Error('已取消');
        last = error?.name === 'AbortError' ? 'timeout' : String(error);
      }
    }
    throw new Error(last || '無法取得下載內容');
  };

  const buildStoredZip = async entries => {
    const encoder = new TextEncoder();
    const locals = [], centrals = [];
    const dt = dosDateTime();
    let offset = 0, centralSize = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const name = encoder.encode(entry.name), data = entry.bytes, crc = crc32(data);
      const header = concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name]);
      locals.push(header, data);
      const central = concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
      centrals.push(central);
      centralSize += central.length;
      offset += header.length + data.length;
      if (i % 12 === 0) await sleep(0);
    }
    const end = concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralSize), u32(offset), u16(0)]);
    return new Blob([...locals, ...centrals, end], { type:'application/zip' });
  };

  const packDownload = async payload => {
    const files = payload?.files || [];
    const total = files.length;
    const requestId = payload?.requestId || crypto.randomUUID();
    const controller = new AbortController();
    backupControllers.set(requestId, controller);
    const entries = new Array(total);
    const used = new Set();
    const errorCounts = new Map();
    let cursor = 0, completed = 0, failed = 0, bytesDone = 0;
    const concurrency = Math.max(1, Math.min(4, Number(payload?.concurrency) || 3));
    const report = extra => post('BACKUP_PROGRESS', { requestId, total, doneCount:completed, failed, bytesDone, ...extra });
    report({ phase:'download', current:'準備下載…' });
    const worker = async () => {
      while (!controller.signal.aborted) {
        const i = cursor++;
        if (i >= total) return;
        const file = files[i];
        report({ phase:'download', current:file.name });
        try {
          const blob = await fetchDownloadBlob(file, controller.signal);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          entries[i] = { name: uniqueName(file.name || `file_${String(i+1).padStart(3,'0')}`, used), bytes };
          bytesDone += bytes.length;
        } catch (error) {
          if (controller.signal.aborted) return;
          failed++;
          const code = String(error?.message || error || '未知錯誤').slice(0,80);
          errorCounts.set(code, (errorCounts.get(code)||0)+1);
        }
        completed++;
        report({ phase:'download', current:file.name, errors:[...errorCounts.entries()].slice(0,5) });
        await sleep(0);
      }
    };
    try {
      await Promise.all(Array.from({ length:Math.min(concurrency,total) }, worker));
      if (controller.signal.aborted) { report({ done:true, cancelled:true, phase:'cancelled', current:'備份已停止', errors:[...errorCounts.entries()] }); return; }
      const good = entries.filter(Boolean);
      if (!good.length) { report({ done:true, phase:'error', error:'沒有任何檔案下載成功', errors:[...errorCounts.entries()] }); return; }
      report({ phase:'packing', current:`正在建立 ZIP · ${good.length} 個檔案` });
      const zip = await buildStoredZip(good);
      report({ phase:'saving', current:`正在準備下載 · ${fmtZipBytes(zip.size)}` });
      const href = URL.createObjectURL(zip);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = cleanName(payload.archiveName || 'chatgpt-library') + '.zip';
      anchor.style.display = 'none';
      document.documentElement.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
      report({ done:true, phase:'done', current:`${good.length} 個檔案已打包`, errors:[...errorCounts.entries()] });
    } catch (error) {
      report({ done:true, phase:'error', error:String(error?.message || error), errors:[...errorCounts.entries()] });
    } finally { backupControllers.delete(requestId); }
  };
  const fmtZipBytes = n => {
    const units=['B','KB','MB','GB']; let v=Number(n)||0,i=0;
    while(v>=1024&&i<units.length-1){v/=1024;i++;}
    return `${v>=10||i===0?v.toFixed(0):v.toFixed(1)} ${units[i]}`;
  };

  window.fetch = async function(input, init = {}) {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const method = String(init.method || (req && req.method) || 'GET').toUpperCase();
    if (/\/backend-api\/files\/library\/files\/delete-batch(?:\?|$)/.test(url) && method === 'POST') {
      const headers = {};
      try { new Headers(init.headers || (req && req.headers) || {}).forEach((v,k)=>headers[k]=v); } catch {}
      learnedDeleteHeaders = cleanHeaders(headers);
    }
    const response = await originalFetch(input, init);
    if ((!learnedLibrarySource || Date.now() < discoveryUntil) && isLibraryRequest(url) && ['GET','POST'].includes(method)) {
      try {
        const clone = response.clone();
        const json = safeJson(await clone.text());
        const candidates = json ? uniqueCandidates(extractCandidates(json)) : [];
        if (candidates.length) {
          let body = init.body;
          if (body == null && req && method === 'POST') { try { body = await req.clone().text(); } catch {} }
          const headers = {};
          try { new Headers(init.headers || (req && req.headers) || {}).forEach((v,k)=>headers[k]=v); } catch {}
          learnedLibrarySource = normalizeLibrarySource(url, method, headers, typeof body === 'string' ? body : null);
          learnedLibraryFirstPage = { json, candidates };
          post('LIBRARY_SOURCE_READY', { method, url: learnedLibrarySource.url, count:candidates.length });
        }
      } catch {}
    }
    return response;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    try {
      this.__lcLibraryMeta = {
        method: String(method || 'GET').toUpperCase(),
        url: new URL(String(url || ''), location.href).href,
        headers: {}
      };
    } catch {
      this.__lcLibraryMeta = null;
    }
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(key, value) {
    if (this.__lcLibraryMeta) this.__lcLibraryMeta.headers[String(key).toLowerCase()] = String(value);
    return xhrSetHeader.call(this, key, value);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const meta = this.__lcLibraryMeta;
    if (meta && isLibraryRequest(meta.url) && ['GET','POST'].includes(meta.method) && (!learnedLibrarySource || Date.now() < discoveryUntil)) {
      this.addEventListener('loadend', () => {
        try {
          if (this.status < 200 || this.status >= 300 || typeof this.responseText !== 'string') return;
          const json = safeJson(this.responseText);
          if (!json) return;
          const candidates = uniqueCandidates(extractCandidates(json));
          if (!candidates.length) return;
          const bodyText = typeof body === 'string' ? body : null;
          learnedLibrarySource = normalizeLibrarySource(meta.url, meta.method, meta.headers, bodyText);
          learnedLibraryFirstPage = { json, candidates };
          post('LIBRARY_SOURCE_READY', { method: meta.method, url: learnedLibrarySource.url, count: candidates.length });
        } catch {}
      }, { once:true });
    }
    return xhrSend.call(this, body);
  };

  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;
    if (msg.type === 'PING_BRIDGE') { post('BRIDGE_READY', { version:'2.0' }); return; }
    if (msg.type === 'REQUEST_ACCOUNT') return detectAccount();
    if (msg.type === 'SYNC_LIBRARY') return runFullSync(msg.payload || {});
    if (msg.type === 'STOP_SYNC') {
      syncControllers.get(msg.payload?.requestId)?.abort();
      return;
    }
    if (msg.type === 'DELETE_BATCH') return deleteBatch(msg.payload);
    if (msg.type === 'ENRICH_METADATA') return enrichMetadata(msg.payload || {});
    if (msg.type === 'STOP_METADATA') { metadataControllers.get(msg.payload?.requestId)?.abort(); return; }
    if (msg.type === 'RESOLVE_PREVIEW') return resolvePreview(msg.payload);
    if (msg.type === 'PACK_BACKUP') return packDownload(msg.payload || {});
    if (msg.type === 'CANCEL_BACKUP') { backupControllers.get(msg.payload?.requestId)?.abort(); return; }
    if (msg.type === 'CLEAR_PREVIEWS') {
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
    }
  });

  post('BRIDGE_READY');
  setTimeout(detectAccount, 50);

  post('BRIDGE_READY', { version:'2.0' });
})();
