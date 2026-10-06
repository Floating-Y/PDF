
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
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const rq = db.transaction('kv', mode).objectStore('kv')[mode === 'readonly' ? 'get' : 'put'](mode === 'readonly' ? key : val, key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  } catch (e) { return null; }
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
    // 去重：同名同大小，或桌面版同路径（写回后文件大小变了，只按大小会留下重复条目）
    ...(await loadRecents()).filter(e => !(e.name === name && e.size === size) &&
      !(e.handle?.path && handle?.path && e.handle.path === handle.path)),
  ].slice(0, 6);
  await saveRecents(list);
  renderRecents();
}
async function renderRecents() {
  if (!('showOpenFilePicker' in window)) return; // 不支持文件句柄的浏览器不显示
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
          await saveRecents((await loadRecents()).filter(x => !(x.name === e.name && x.size === e.size)));
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
// 每次修改防抖 800ms 写入 IndexedDB（按 文件名+大小 分 key）；导出成功或改回原样即清除。
// beforeunload 只能拦正常关闭，崩溃 / 杀进程 / 断电全靠这里兜底。
const SESS_PREFIX = 'sess:';
const sessKey = (name, size) => SESS_PREFIX + name + ':' + size;

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
  try {
    const db = await idbOpen();
    db.transaction('kv', 'readwrite').objectStore('kv').delete(key);
  } catch (e) {}
}

let sessionSaveTimer = null;
function scheduleSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSession, 800);
}
async function saveSession() {
  if (!S.pdfDoc || !dirty) return;
  const anns = [];
  for (const list of S.anns.values()) anns.push(...list);
  const pristine = S.pageOrder.every((s, i) => s.src === i && !s.rot);
  if (!anns.length && pristine) { idbDel(sessKey(S.docName, S.docSize)); return; } // 改回原样=没改，不留会话
  await idbOp('readwrite', sessKey(S.docName, S.docSize), {
    name: S.docName, size: S.docSize, at: Date.now(), slot: S.currentSlot, path: S.srcPath,
    pageOrder: S.pageOrder.map(s => ({ src: s.src, rot: s.rot })),
    anns, annSeq,
  });
}

// 打开文件时若存有该文件的未导出会话 → 自动应用（撤销栈不可序列化，恢复后为空）
async function maybeRestoreSession(name, size) {
  const st = await idbOp('readonly', sessKey(name, size));
  if (!st || !Array.isArray(st.anns)) return;
  const pristine = (st.pageOrder || []).every((s, i) => s.src === i && !s.rot);
  if (!st.anns.length && pristine) return;
  await applySession(st);
  toast(`已恢复上次未导出的修改（${st.anns.length} 处标注${pristine ? '' : '，含页面改动'}）`);
}
async function applySession(st) {
  S.pageOrder = st.pageOrder.map(s => ({ src: s.src, rot: s.rot }));
  S.srcPath = st.path || null; // 桌面版：恢复后 Ctrl+S 仍可写回原文件
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
  const pristine = (st.pageOrder || []).every((s, i) => s.src === i && !s.rot);
  $('#recoverMsg').textContent = `${st.name} · ${st.anns.length} 处标注${pristine ? '' : ' · 含页面改动'} · ${fmtTime(st.at)}`;
  $('#btnRecover').onclick = async () => {
    const f = await idbOp('readonly', 'session-file');
    if (f && f.name === st.name && f.size === st.size) {
      openFile(new File([f.bytes], st.name, { type: 'application/pdf' })); // 打开后自动应用会话
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
