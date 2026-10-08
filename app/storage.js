
// ---------------- 最近打开（文件句柄存 IndexedDB，可一键重开） ----------------
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pdfpro', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbOp(mode, key, val) {
  let db;
  try {
    db = await idbOpen();
    return await new Promise((res, rej) => {
      const tx = db.transaction('kv', mode);
      const rq = tx.objectStore('kv')[mode === 'readonly' ? 'get' : 'put'](mode === 'readonly' ? key : val, key);
      tx.oncomplete = () => res(rq.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } catch (e) { return null; }
  finally { if (db) db.close(); }
}
async function loadRecents() { return (await idbOp('readonly', 'recents')) || []; }
async function saveRecents(list) { await idbOp('readwrite', 'recents', list); }
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtTime(t) {
  const d = Date.now() - t, day = 86400000;
  if (d < day) return '今天';
  if (d < 2 * day) return '昨天';
  if (d < 7 * day) return Math.floor(d / day) + ' 天前';
  return new Date(t).toLocaleDateString();
}
async function recordRecent(name, handle, size) {
  if (!handle) return; // 只有拿到文件句柄的打开方式（选择器/拖拽）才能"一键重开"
  const list = [
    { name, handle, size, at: Date.now() },
    // 桌面版只按路径去重：同名同大小也可能是不同目录的两份文件。
    ...(await loadRecents()).filter(e => e.handle?.path && handle.path
      ? normPath(e.handle.path) !== normPath(handle.path)
      : !(e.name === name && e.size === size)),
  ].slice(0, 6);
  await saveRecents(list);
  renderRecents();
}
async function renderRecents() {
  if (!TAURI && !('showOpenFilePicker' in window)) return; // 桌面版用路径，不依赖浏览器文件句柄
  const list = await loadRecents();
  const box = $('#recentBox'), listEl = $('#recentList');
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  listEl.textContent = '';
  for (const e of list) {
    const b = document.createElement('button');
    b.className = 'recent-item';
    b.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 1.8h5L12.2 5v8.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z"/><path d="M9 1.8V5h3.2"/></svg>' +
      `<span class="rname">${esc(e.name)}</span><span class="rmeta">${fmtSize(e.size)} · ${fmtTime(e.at)}</span>`;
    b.addEventListener('click', async () => {
      // 桌面版：recents 存的是路径，直接读（无权限重授权流程）
      if (e.handle && e.handle.path) {
        if (!(await openPath(e.handle.path))) {
          await saveRecents((await loadRecents()).filter(x => !x.handle?.path || normPath(x.handle.path) !== normPath(e.handle.path)));
          renderRecents();
        }
        return;
      }
      try {
        let perm = await e.handle.queryPermission({ mode: 'read' });
        if (perm !== 'granted') perm = await e.handle.requestPermission({ mode: 'read' });
        if (perm !== 'granted') { toast('没有获得读取该文件的权限'); return; }
        openFile(await e.handle.getFile(), e.handle);
      } catch (err) {
        // 文件被移动/删除：从最近列表移除
        toast('无法打开该文件（可能已被移动或删除）');
        await saveRecents((await loadRecents()).filter(x => !(x.name === e.name && x.size === e.size)));
        renderRecents();
      }
    });
    listEl.appendChild(b);
  }
}
renderRecents();

// ---------------- 编辑会话自动保存（崩溃 / 误关后恢复） ----------------
// 每次修改防抖 800ms 写入 IndexedDB；内容摘要隔离同名同大小文件，桌面版再按路径隔离副本。
// beforeunload 只能拦正常关闭，崩溃 / 杀进程 / 断电全靠这里兜底。
const SESS_PREFIX = 'sess:';
async function sessKey(name, bytes, path) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map(n => n.toString(16).padStart(2, '0')).join('');
  return SESS_PREFIX + JSON.stringify([path ? normPath(path) : name, hash]);
}

async function idbKeys() {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const rq = db.transaction('kv').objectStore('kv').getAllKeys();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
  } catch (e) { return []; }
}
async function idbDel(key) {
  if (!key) return;
  let db;
  try {
    db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } catch (e) {}
  finally { if (db) db.close(); }
}

let sessionSaveTimer = null;
function scheduleSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSession, 800);
}
async function saveSession() {
  if (!S.pdfDoc || !S.sessionKey) return false;
  if (!hasDocumentChanges()) { await idbDel(S.sessionKey); return true; }
  if (!dirty) return false;
  const anns = [];
  for (const list of S.anns.values()) anns.push(...list);
  const result = await idbOp('readwrite', S.sessionKey, {
    name: S.docName, size: S.docSize, at: Date.now(), slot: S.currentSlot, path: S.srcPath,
    sourcePages: S.pdfDoc.numPages,
    pageOrder: S.pageOrder.map(s => ({ src: s.src, rot: s.rot })),
    anns, annSeq,
  });
  if (result === null) toast('自动保存失败，未导出的修改无法在关闭后恢复，请及时保存', 5000);
  return result !== null;
}

// 打开文件时若存有该文件的未导出会话 → 自动应用（撤销栈不可序列化，恢复后为空）
async function maybeRestoreSession() {
  const st = await idbOp('readonly', S.sessionKey);
  if (!st || !Array.isArray(st.anns) || !Array.isArray(st.pageOrder)) return;
  const pristine = pageOrderIsOriginal(st.pageOrder, S.pdfDoc.numPages);
  if (!st.anns.length && pristine) return;
  await applySession(st);
  toast(`已恢复上次未导出的修改（${st.anns.length} 处标注${pristine ? '' : '，含页面改动'}）`);
}
async function applySession(st) {
  S.pageOrder = st.pageOrder.map(s => ({ src: s.src, rot: s.rot }));
  // 保存路径只来自这次实际打开的文件；缓存会话不能把 Ctrl+S 指向另一份原件。
  S.anns = new Map();
  for (const a of st.anns) {
    if (!S.anns.has(a.page)) S.anns.set(a.page, []);
    S.anns.get(a.page).push(a);
  }
  annSeq = Math.max(annSeq, st.annSeq || 1);
  // FontFace 不跨页面存在，恢复时重新注册用到的内嵌原字体
  const jobs = new Set();
  for (const a of st.anns) {
    if (a.type !== 'edit') continue;
    if (a.runs) a.runs.forEach(r => r.fontName && jobs.add(ensureEmbeddedFace(a.page, r.fontName)));
    else if (a.fontName) jobs.add(ensureEmbeddedFace(a.page, a.fontName));
  }
  await Promise.all([...jobs]);
  markDirty();
  await buildViewer(Math.min(st.slot || 0, S.pageOrder.length - 1));
}

// 启动横幅：展示最近一个未导出会话（继续编辑 / 放弃）；多个会话时其余在各自文件重开时自动恢复
async function cleanupSessionFile() {
  const has = (await idbKeys()).some(k => k.startsWith(SESS_PREFIX));
  if (!has) idbDel('session-file'); // 没有任何待恢复会话时，不留原文件字节副本
}
async function renderRecover() {
  const box = $('#recoverBox');
  let best = null;
  for (const k of (await idbKeys()).filter(k => k.startsWith(SESS_PREFIX))) {
    const st = await idbOp('readonly', k);
    if (st && Array.isArray(st.anns) && (!best || st.at > best.st.at)) best = { st, key: k };
  }
  if (!best) { box.hidden = true; return; }
  const { st, key } = best;
  box.hidden = false;
  const pristine = pageOrderIsOriginal(st.pageOrder, st.sourcePages ?? st.pageOrder?.length);
  $('#recoverMsg').textContent = `${st.name} · ${st.anns.length} 处标注${pristine ? '' : ' · 含页面改动'} · ${fmtTime(st.at)}`;
  $('#btnRecover').onclick = async () => {
    const f = await idbOp('readonly', 'session-file');
    if (TAURI && st.path && await openPath(st.path) && S.sessionKey === key) return;
    if (f && (f.key === key || (!f.key && f.name === st.name && f.size === st.size))) {
      if (await openFile(new File([f.bytes], st.name, { type: 'application/pdf' }))) {
        // 旧版 key 及桌面字节副本通过显式“继续编辑”恢复，副本没有原文件写入权限。
        await applySession(st);
        if (S.sessionKey !== key && await saveSession()) await idbDel(key);
        if (TAURI && st.path) toast('原文件已变化或无法读取，已恢复为副本，请另存为', 5000);
      }
    } else {
      toast(`请重新打开「${st.name}」，未导出的修改会自动恢复`);
    }
  };
  $('#btnRecoverDiscard').onclick = async () => {
    await idbDel(key);
    await cleanupSessionFile();
    renderRecover();
  };
}
renderRecover();
