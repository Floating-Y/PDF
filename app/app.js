/* global pdfjsLib, PDFLib, fontkit */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

// ---------------- 桌面版（Tauri）适配 ----------------
// WebView 里没有 File System Access API，文件 I/O 换成原生对话框 + 自定义命令直读直写；
// 浏览器版路径全部保留，同一份代码两种形态
const TAURI = !!window.__TAURI__;
const ti = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
// 分块 base64 写文件（JSON 传大数组两端都慢；512KB 原始 ≈ 700KB base64 每块）
async function writeBytesTauri(path, bytes) {
  const CH = 512 * 1024;
  const temporaryPath = path + '.tmp-' + crypto.randomUUID();
  for (let i = 0; ; i += CH) {
    const part = bytes.subarray(i, i + CH);
    let bin = '';
    for (let j = 0; j < part.length; j += 8192) bin += String.fromCharCode.apply(null, part.subarray(j, j + 8192));
    await ti('write_chunk', { path, temporaryPath, b64: btoa(bin), append: i > 0, finish: i + CH >= bytes.length });
    if (i + CH >= bytes.length) break;
  }
}
// 按路径打开（桌面版：选择器 / 拖拽 / 最近打开 / 文件关联共用）
async function openPath(path, savedReload = false) {
  if (savingPdf && !savedReload) { toast('正在保存，请稍后再打开文件'); return false; }
  toast('正在打开：' + path.replace(/^.*[\\/]/, ''), 8000);
  try {
    const bin = atob(await ti('read_file', { path }));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // await：写回后的 reload 依赖"打开完成"语义（跳页/恢复缩放要在视图重建后进行）
    return await openFile(new File([bytes], path.replace(/^.*[\\/]/, ''), { type: 'application/pdf' }), { path }, null, savedReload);
  } catch (e) {
    toast('无法读取该文件：' + e);
    return false;
  }
}

// ---------------- state ----------------
const S = {
  pdfDoc: null, srcBytes: null, docName: '', docSize: 0, srcPath: null, sessionKey: null, // srcPath：桌面版写回原文件用
  pageOrder: [],            // [{src, rot}]  src = 原文档页索引, rot = 额外旋转
  anns: new Map(),          // src -> [ann]
  scale: 1, zoomMode: 'custom', tool: 'select', color: '#f6d743',
  selectedId: null, editingId: null, currentSlot: 0,
  views: new Map(),         // slot -> {page, viewport}
  slotDims: new Map(),      // slot -> {w, h}  (scale=1, 含旋转)
  tcCache: new Map(),       // src -> textContent
  history: [], redo: [],    // 标注级撤销 / 重做
  gen: 0,
};
const DPR = Math.min(window.devicePixelRatio || 1, 2);
let annSeq = 1;
let pageEls = [];
let io = null;
const renderTasks = new Map(); // slot -> {render, text}
const slotRetries = new Map(); // slot -> 已自动重试次数（防节流下无限重试）

const viewer = $('#viewer');
const viewerWrap = $('#viewerWrap');
const welcome = $('#welcome');
const toastEl = $('#toast');
let toastTimer = null;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, ms);
}
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------- 未导出修改标记 ----------------
let dirty = false;
let savingPdf = false;
function pageOrderIsOriginal(order, pageCount) {
  return Array.isArray(order) && order.length === pageCount && order.every((s, i) => s.src === i && !s.rot);
}
function hasDocumentChanges() {
  return !!S.pdfDoc && (!pageOrderIsOriginal(S.pageOrder, S.pdfDoc.numPages) ||
    [...S.anns.values()].some(list => list.length));
}
function markDirty() {
  dirty = hasDocumentChanges();
  $('#btnSave').classList.toggle('dirty', dirty);
  scheduleSessionSave(); // 修改即存 IndexedDB（防抖），崩溃 / 误关后可恢复
}
function clearDirty() { dirty = false; $('#btnSave').classList.remove('dirty'); }
// 撤销 / 删除可能回到"无任何实质修改"（判定规则与 saveSession 一致）：此时清除未导出标记
function refreshDirty() {
  if (!S.pdfDoc) return;
  if (!hasDocumentChanges()) {
    clearDirty();
    clearTimeout(sessionSaveTimer);
    idbDel(S.sessionKey);
  } else markDirty();
}
window.addEventListener('beforeunload', e => {
  if (!TAURI && dirty && S.pdfDoc) { e.preventDefault(); e.returnValue = ''; }
});
// 桌面版：beforeunload 拦不住窗口关闭，用 onCloseRequested；另接拖拽文件与文件关联事件
if (TAURI) {
  document.body.classList.add('tauri'); // 工具栏为窗口按钮留出右上角保留区
  const win = window.__TAURI__.window.getCurrentWindow();
  win.onCloseRequested(async e => {
    if (!dirty || !S.pdfDoc) return;
    e.preventDefault();
    if (confirm('有未导出的修改，确定直接关闭吗？')) await win.destroy();
  });
  win.onDragDropEvent(ev => {
    if (ev.payload.type !== 'drop' || !ev.payload.paths?.length) return;
    const p = ev.payload.paths[0];
    if (/\.pdf$/i.test(p)) openPath(p); else toast('请拖入 PDF 文件');
  });
  const openPathListener = window.__TAURI__.event.listen('open-pdf-path', ev => openPath(ev.payload));
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await openPathListener;
      const path = await ti('startup_pdf_path');
      if (path) await openPath(path);
    } catch (err) { console.error(err); toast('无法打开启动文件：' + err); }
  }, { once: true });
  // 自绘窗口控制（工具栏兼任标题栏）：最小化 / 最大化切换（图标随状态）/ 关闭（走 onCloseRequested 的未保存确认）
  const wc = $('#winControls');
  wc.hidden = false;
  $('#winMin').addEventListener('click', () => win.minimize());
  $('#winMax').addEventListener('click', () => win.toggleMaximize());
  $('#winClose').addEventListener('click', () => win.close());
  const setMaxIcon = m => $('#winMax').classList.toggle('maximized', m);
  win.isMaximized().then(setMaxIcon);
  win.onResized(async () => setMaxIcon(await win.isMaximized()));
}

// ---------------- 打开文档 ----------------
$('#fileInput').addEventListener('change', e => { openFile(e.target.files[0]); e.target.value = ''; });

// 优先用系统文件选择器（能拿到句柄，支持"最近打开"一键重开），不支持时回退传统 input
async function pickFile() {
  if (TAURI) {
    const path = await ti('dialog_open_pdf');
    if (path) openPath(path);
    return;
  }
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
      openFile(await h.getFile(), h);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 用户取消
      console.error(e);
    }
  }
  $('#fileInput').click();
}
$('#btnOpen').addEventListener('click', pickFile);
$('#btnOpen2').addEventListener('click', pickFile);

document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging-file'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging-file'); });
document.addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('dragging-file');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  // Chromium：拖拽项可取文件句柄，记入"最近打开"
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  openFile(f, null, item && item.getAsFileSystemHandle ? item : null);
});

async function openFile(file, handle = null, handleItem = null, savedReload = false) {
  if (!file) return false;
  if (savingPdf && !savedReload) { toast('正在保存，请稍后再打开文件'); return false; }
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('请选择 PDF 文件'); return false; }
  toast('正在打开：' + file.name, 8000);
  let pwCancelled = false; // try 内声明 catch 拿不到，放外面
  try {
    if (!handle && handleItem) {
      try { const h = await handleItem.getAsFileSystemHandle(); if (h && h.kind === 'file') handle = h; } catch (e) {}
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sessionKey = await sessKey(file.name, bytes, handle && handle.path);
    // cMaps/标准字体用于未内嵌字体的 PDF（常见于中文 PDF）：缺失时整页文字不渲染，只剩矢量图形
    const loadingTask = pdfjsLib.getDocument({
      data: bytes.slice(),
      fontExtraProperties: true,
      cMapUrl: '/vendor/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/standard_fonts/',
    });
    // 加密 PDF：弹密码框（密码错会以 INCORRECT_PASSWORD 再次触发），取消则放弃打开
    loadingTask.onPassword = (update, reason) => {
      const wrong = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      const pw = prompt(wrong ? '密码不正确，请重新输入该 PDF 的打开密码：' : '该 PDF 设有打开密码，请输入密码：');
      if (pw == null) { pwCancelled = true; loadingTask.destroy(); return; }
      update(pw);
    };
    const doc = await loadingTask.promise;
    if (savingPdf && !savedReload) { await doc.destroy(); toast('正在保存，请稍后再打开文件'); return false; }
    // 切换文件前立即留住修改，避免 800ms 防抖尚未执行就把旧状态覆盖。
    await saveSession();
    if (savingPdf && !savedReload) { await doc.destroy(); toast('正在保存，请稍后再打开文件'); return false; }
    clearTimeout(sessionSaveTimer);
    if (S.pdfDoc) { try { S.pdfDoc.destroy(); } catch (e) {} } // 释放旧文档及其 worker，防止累积拖慢渲染
    S.gen++;
    cancelAllRenders();
    if (io) io.disconnect();
    S.pdfDoc = doc; S.srcBytes = bytes; S.docName = file.name; S.docSize = file.size;
    S.srcPath = (handle && handle.path) || null;
    S.sessionKey = sessionKey;
    $('#btnSave').disabled = true; // 视图和恢复会话就绪前不允许合成保存
    // 原文件字节留档 IndexedDB：启动横幅"继续编辑"无需用户再找原文件
    idbOp('readwrite', 'session-file', { name: file.name, size: file.size, bytes, key: sessionKey });
    S.pageOrder = Array.from({ length: doc.numPages }, (_, i) => ({ src: i, rot: 0 }));
    S.anns = new Map(); S.tcCache = new Map(); S.history = []; S.redo = [];
    // 旧文档的搜索结果对新文档无意义，重置
    searchState = { q: '', results: [], cur: -1 };
    $('#searchBox').value = '';
    updateSearchCount(); showSearchPanel(false);
    $('#tab-results').innerHTML = '<div class="muted pad">输入关键词后回车搜索</div>';
    S.selectedId = null; S.editingId = null; S.currentSlot = 0;
    S.views.clear(); S.slotDims.clear();
    annSeq = 1;
    resetEmbeddedCache();
    clearDirty();
    hideSelBar();
    document.body.classList.remove('no-doc');
    document.title = file.name + ' — PDF 阅读器';
    // 先取出记忆的缩放状态再 setScale（setScale 会把它覆盖写回）
    const zoomPref = (() => { try { return localStorage.getItem('pdf-zoom'); } catch (e) { return null; } })();
    setScale(1.2); // 构建期间的基准尺寸
    welcome.classList.add('hidden');
    await buildViewer(0);
    applyZoomPref(zoomPref); // 页面尺寸就绪后才能算适应宽度/页面
    recordRecent(file.name, handle, file.size);
    toast(`已打开：${file.name}（${doc.numPages} 页）`);
    await maybeRestoreSession(); // 有未导出的历史会话 → 自动恢复
    enableToolbar();
    updatePageUI();
    return true;
  } catch (err) {
    console.error(err);
    $('#btnSave').disabled = !S.pdfDoc || savingPdf;
    if (pwCancelled) toast('已取消打开加密文件');
    else toast(err?.name === 'InvalidPDFException' ? '文件已损坏或不是有效的 PDF'
      : err?.name === 'PasswordException' ? '需要密码或密码错误，无法打开'
      : '无法打开该文件：' + err.message);
    return false;
  }
}

function enableToolbar() {
  $$('#toolbar button, #toolbar input').forEach(b => { b.disabled = false; });
  updateAnnUI();
  updateUndoUI();
}

// 删标注按钮的可用状态跟随"是否有选中标注"，而不是一直可点
function updateAnnUI() {
  $('#btnDeleteAnn').disabled = !S.pdfDoc || !S.selectedId;
}

// ---------------- 撤销 / 重做 ----------------
function updateUndoUI() {
  $('#btnUndo').disabled = !S.history.length;
  $('#btnRedo').disabled = !S.redo.length;
}
// 每条历史 = { undo(), redo() }；新操作会清空重做栈
function pushHistory(entry) {
  S.history.push(entry);
  if (S.history.length > 80) S.history.shift();
  S.redo.length = 0;
  markDirty();
  updateUndoUI();
}
function undoLast() {
  const h = S.history.pop();
  if (!h) { toast('没有可撤销的操作'); return; }
  S.redo.push(h);
  h.undo();
  refreshDirty();
  updateUndoUI();
}
function redoNext() {
  const h = S.redo.pop();
  if (!h) { toast('没有可重做的操作'); return; }
  S.history.push(h);
  h.redo();
  refreshDirty();
  updateUndoUI();
}
$('#btnUndo').addEventListener('click', undoLast);
$('#btnRedo').addEventListener('click', redoNext);

// ---------------- 构建页面 DOM ----------------
async function buildViewer(preserveSlot = 0) {
  const gen = ++S.gen;
  cancelAllRenders();
  if (io) io.disconnect();
  // 删页/排序后槽位含义已变，按槽位缓存的尺寸/视图全部作废
  // （混合页面尺寸的文档不清缓存会拿前一页的尺寸布局，S.views 同理）
  S.slotDims.clear();
  S.views.clear();
  slotRetries.clear();
  viewer.innerHTML = '';
  pageEls = [];

  for (let i = 0; i < S.pageOrder.length; i++) {
    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.dataset.slot = i;
    pageEl.innerHTML =
      '<div class="page-inner">' +
      '<canvas></canvas>' +
      '<div class="textLayer"></div>' +
      '<div class="annotationLayer"><svg></svg></div>' +
      '</div>';
    viewer.appendChild(pageEl);
    pageEls.push(pageEl);
  }

  // 先取每页尺寸（scale=1）并设好布局，再开始观察渲染，
  // 避免零高度页面全部被 IO 判定为可见而并发渲染、互相取消
  for (let i = 0; i < S.pageOrder.length; i++) {
    if (S.gen !== gen) return;
    await ensureDims(i);
  }
  if (S.gen !== gen) return;
  pageEls.forEach((_, i) => setPageInnerSize(i));

  io = new IntersectionObserver(entries => {
    for (const en of entries) {
      const slot = +en.target.dataset.slot;
      if (en.isIntersecting) renderPage(slot); else unrenderPage(slot);
    }
  }, { root: viewer, rootMargin: '900px 0px' });
  pageEls.forEach(el => io.observe(el));

  viewer.scrollTop = Math.max(0, (pageEls[preserveSlot]?.offsetTop || 0) - 8);
  updatePageUI();
  // 先让可见页入队渲染，缩略图/目录随后——三者共用串行渲染队列，
  // 缩略图抢先入队会拖慢首屏出图（20 页文档慢 1-2 秒）
  refreshVisible(); // IO 偶发不触发时的兜底（幂等：渲染中/已渲染的槽位会跳过）
  buildThumbs();
  loadOutline();
}

async function ensureDims(slot) {
  if (S.slotDims.has(slot)) return;
  const slotObj = S.pageOrder[slot];
  if (!slotObj) return;
  const page = await S.pdfDoc.getPage(slotObj.src + 1);
  const rot = (page.rotate + slotObj.rot) % 360;
  const v1 = page.getViewport({ scale: 1, rotation: rot });
  S.slotDims.set(slot, { w: v1.width, h: v1.height });
}

function setPageInnerSize(slot) {
  const d = S.slotDims.get(slot);
  const inner = pageEls[slot]?.querySelector('.page-inner');
  if (!d || !inner) return;
  inner.style.width = Math.floor(d.w * S.scale) + 'px';
  inner.style.height = Math.floor(d.h * S.scale) + 'px';
  // 缩放过渡：旧画布位图立即拉伸到新尺寸占位，文字/标注层整体同比例拉伸（位置保持正确），
  // 重渲染完成后由 doRenderPage 换清晰版并清掉拉伸——缩放零延迟、无白闪（pdf.js 查看器同款）
  const v = S.views.get(slot);
  const canvas = inner.querySelector('canvas');
  if (canvas) {
    canvas.style.width = inner.style.width;
    canvas.style.height = inner.style.height;
  }
  const r = v ? S.scale / v.viewport.scale : 1;
  for (const sel of ['.textLayer', '.annotationLayer']) {
    const el = inner.querySelector(sel);
    if (el) el.style.transform = Math.abs(r - 1) < 1e-3 ? '' : `scale(${r})`;
  }
}

function refreshVisible() {
  if (!pageEls.length) return;
  const vr = viewer.getBoundingClientRect();
  pageEls.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    // 零高度的页还没布局完（构建中途），跳过——否则会被当作可见而全量渲染
    const vis = r.height > 2 && r.bottom > vr.top - 900 && r.top < vr.bottom + 900;
    if (vis) { if (!renderTasks.has(i) && !S.views.has(i)) renderPage(i); }
    else unrenderPage(i);
  });
}

// ---------------- 页面渲染 ----------------
function cancelRender(slot) {
  const t = renderTasks.get(slot);
  if (t) {
    try { t.render?.cancel(); } catch (e) {}
    try { t.text?.cancel(); } catch (e) {}
    renderTasks.delete(slot);
  }
}
function cancelAllRenders() { [...renderTasks.keys()].forEach(cancelRender); }

// 渲染串行队列：worker 中同时只跑一个渲染，避免并发渲染竞态导致管线卡死
const renderQueue = { chain: Promise.resolve() };
function enqueueRender(fn) {
  const p = renderQueue.chain.then(fn, fn);
  renderQueue.chain = p.catch(() => {});
  return p;
}

function unrenderPage(slot) {
  cancelRender(slot);
  const canvas = pageEls[slot]?.querySelector('canvas');
  if (canvas) { canvas.width = 1; canvas.height = 1; }
}

function renderPage(slot) {
  return enqueueRender(() => doRenderPage(slot));
}

async function doRenderPage(slot) {
  if (!S.pdfDoc) return;
  const gen = S.gen;
  const slotObj = S.pageOrder[slot];
  const pageEl = pageEls[slot];
  if (!slotObj || !pageEl) return;
  // 等待上一次渲染任务完全结束（cancel 后 promise 会 reject，需吞掉），避免同画布多任务卡死；
  // 上限 3s，防止任务永久挂起阻塞后续渲染
  const prev = renderTasks.get(slot);
  if (prev) {
    cancelRender(slot);
    await Promise.race([
      Promise.allSettled([prev.render?.promise, prev.text?.promise]),
      new Promise(r => setTimeout(r, 3000)),
    ]);
    if (S.gen !== gen) return;
  }
  try {
    const page = await S.pdfDoc.getPage(slotObj.src + 1);
    if (S.gen !== gen) return;
    const rotation = (page.rotate + slotObj.rot) % 360;
    const viewport = page.getViewport({ scale: S.scale, rotation });
    S.views.set(slot, { page, viewport });
    // 渲染进离屏画布：画完才一次性上屏——期间旧位图（已拉伸占位）保持显示，无白闪
    const off = document.createElement('canvas');
    off.width = Math.floor(viewport.width * DPR);
    off.height = Math.floor(viewport.height * DPR);
    const inner = pageEl.querySelector('.page-inner');
    inner.style.setProperty('--scale-factor', viewport.scale);
    // 渲染带超时自愈：卡死 → 取消 → 重试（最多 3 次）
    let task = page.render({
      canvasContext: off.getContext('2d'),
      viewport,
      transform: DPR !== 1 ? [DPR, 0, 0, DPR, 0, 0] : undefined,
    });
    renderTasks.set(slot, { render: task });
    let painted = false;
    for (let attempt = 0; attempt < 3 && !painted; attempt++) {
      try {
        await Promise.race([
          task.promise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('render-timeout')), 20000)),
        ]);
        painted = true;
        slotRetries.delete(slot);
      } catch (e) {
        if (e.message !== 'render-timeout') {
          if (!/cancel/i.test(String(e?.name || e))) console.error(e);
          renderTasks.delete(slot);
          return;
        }
        console.warn('render slot ' + slot + ' 超时，取消重试');
        try { task.cancel(); await Promise.race([task.promise, new Promise(r => setTimeout(r, 3000))]); } catch (e2) {}
        if (S.gen !== gen) return;
        if (attempt < 2) {
          task = page.render({
            canvasContext: off.getContext('2d'),
            viewport,
            transform: DPR !== 1 ? [DPR, 0, 0, DPR, 0, 0] : undefined,
          });
          renderTasks.set(slot, { render: task });
        } else {
          console.error('render slot ' + slot + ' 连续超时，放弃（稍后自动重试）');
          renderTasks.delete(slot);
          const n = (slotRetries.get(slot) || 0) + 1;
          slotRetries.set(slot, n);
          if (n <= 5) {
            setTimeout(() => {
              if (!S.pdfDoc || !pageEls[slot] || renderTasks.has(slot)) return;
              const r = pageEls[slot].getBoundingClientRect();
              const vr = viewer.getBoundingClientRect();
              if (r.bottom > vr.top && r.top < vr.bottom) renderPage(slot);
            }, 4000);
          }
          return;
        }
      }
    }
    if (S.gen !== gen) return;
    // 清晰位图就绪：一次性换上，并清掉缩放期间的占位拉伸
    const canvas = pageEl.querySelector('canvas');
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    for (const sel of ['.textLayer', '.annotationLayer']) {
      const el = inner.querySelector(sel);
      if (el) el.style.transform = '';
    }
    // 文本层（选择/复制），同样带超时保护
    const tc = await getTextContent(slotObj.src);
    if (S.gen !== gen) return;
    const tl = pageEl.querySelector('.textLayer');
    tl.textContent = '';
    const tlt = pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport });
    renderTasks.set(slot, { render: task, text: tlt });
    try {
      await Promise.race([
        tlt.promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('textlayer-timeout')), 15000)),
      ]);
    } catch (e) {
      try { tlt.cancel(); } catch (e2) {}
      if (e.message === 'textlayer-timeout') console.warn('textLayer slot ' + slot + ' 超时，跳过（滚动后再进会重试）');
    }
    if (S.gen !== gen) return;
    renderAnnotations(slot);
  } catch (err) {
    console.error('renderPage', slot, err);
  }
}

async function getTextContent(src) {
  if (!S.tcCache.has(src)) {
    const page = await S.pdfDoc.getPage(src + 1);
    S.tcCache.set(src, await page.getTextContent());
  }
  return S.tcCache.get(src);
}

// ---------------- 标注渲染 ----------------
function annOf(id) {
  for (const list of S.anns.values()) {
    const a = list.find(x => x.id === id);
    if (a) return a;
  }
  return null;
}
function annSlotOf(id) {
  for (let i = 0; i < S.pageOrder.length; i++) {
    if (S.pageOrder[i].src === annOf(id)?.page) return i;
  }
  return -1;
}

function renderAnnotations(slot) {
  const layer = pageEls[slot]?.querySelector('.annotationLayer');
  const v = S.views.get(slot);
  if (!layer || !v) return;
  const vp = v.viewport;
  const sc = vp.scale;
  const rot = ((vp.rotation % 360) + 360) % 360;
  let shapes = '';
  const texts = [];
  const list = S.anns.get(S.pageOrder[slot].src) || [];
  const tl = p => vp.convertToViewportPoint(p[0], p[1]);
  // 旋转安全矩形：两个对角点都过变换再取 min/max（90°/270° 时宽高互换，
  // 只变换一个角点 + 标量宽高会把矩形画错）
  const vrect = (x1, y1, x2, y2) => {
    const [ax, ay] = tl([x1, y1]);
    const [bx, by] = tl([x2, y2]);
    return `x="${Math.min(ax, bx)}" y="${Math.min(ay, by)}" width="${Math.abs(bx - ax)}" height="${Math.abs(by - ay)}"`;
  };
  // 旋转页上文字随页面转向：锚点放基线起点，绕锚点旋转后再上移一行（0° 时与不旋转完全等价）
  const rotCss = `transform-origin:0 0;transform:rotate(${rot}deg) translateY(-0.97em);`;
  // 搜索"全部高亮"：所有命中浅底、当前命中深底描边（随标注层一起重绘）
  if (searchState.q && searchHLAll && searchState.results.length) {
    const ssrc = S.pageOrder[slot].src;
    for (let i = 0; i < searchState.results.length; i++) {
      const rr = searchState.results[i];
      if (rr.src !== ssrc || !rr.rect) continue;
      const [hx, hy] = tl([rr.rect[0], rr.rect[3]]);
      shapes += `<rect class="search-hit${i === searchState.cur ? ' cur' : ''}" x="${hx}" y="${hy}" width="${(rr.rect[2] - rr.rect[0]) * sc}" height="${(rr.rect[3] - rr.rect[1]) * sc}"/>`;
    }
  }
  for (const a of list) {
    const sel = a.id === S.selectedId ? ' selected' : '';
    if (a.type === 'highlight') {
      const rs = a.rects.map(r => `<rect ${vrect(r[0], r[1], r[2], r[3])} fill="${a.color}" opacity="0.4"/>`).join('');
      shapes += `<g data-ann-id="${a.id}" class="ann-shape${sel}">${rs}</g>`;
    } else if (a.type === 'underline' || a.type === 'strike') {
      // 沿选区基线画线：两个端点各自过旋转变换（90°/270° 时线随页面转向）
      const ls = a.rects.map(r => {
        const { y, th } = markLine(a.type, r);
        const p1 = tl([r[0], y]), p2 = tl([r[2], y]);
        return `<line x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}" stroke="${a.color}" stroke-width="${th * sc}"/>`;
      }).join('');
      shapes += `<g data-ann-id="${a.id}" class="ann-shape${sel}">${ls}</g>`;
    } else if (a.type === 'edit') {
      // 涂白原文
      const rs = a.rects.map(r => `<rect ${vrect(r[0], r[1], r[2], r[3])} fill="#ffffff"/>`).join('');
      shapes += `<g data-ann-id="${a.id}" class="ann-shape${sel}">${rs}</g>`;
      const editing = S.editingId === a.id;
      if (editing || !a.runs) {
        // 编辑中（或选区替换单 run）：一个可编辑框，文本为带空格的整行
        const r0 = a.runs?.[0];
        const x = r0 ? r0.x : a.rects[0][0];
        const baseY2 = r0 ? r0.baselineY : (a.baselineY != null ? a.baselineY : a.rects[0][3]);
        const sizePx = (r0 ? r0.size : a.size) * sc;
        const [vx, vy] = tl([x, baseY2]);
        const f = runFaceCss(r0?.fontName ? embeddedFaceCache.get(r0.fontName) : a.faceId, a.fontKey, a.text, sizePx);
        const fw = f.hasFace ? 400 : (a.fontKey?.bold ? 700 : 400);
        const fst = f.hasFace || f.cjk ? 'normal' : (a.fontKey?.italic ? 'italic' : 'normal');
        texts.push(`<div class="ann-text${sel}" data-ann-id="${a.id}" contenteditable="false" style="left:${vx}px;top:${vy}px;${rotCss}font-size:${sizePx}px;line-height:1.25;color:${a.color};font-family:${f.css};font-weight:${fw};font-style:${fst};padding:0;white-space:pre">${esc(a.text || '')}</div>`);
      } else {
        // 提交后的常态：按原始 run 结构渲染，位置/字体与原文一致
        for (const r of a.runs) {
          if (!r.cur) continue;
          const [vx, vy] = tl([r.x, r.baselineY]);
          const sizePx = r.size * sc;
          const f = runFaceCss(r.fontName ? embeddedFaceCache.get(r.fontName) : null, a.fontKey, r.cur, sizePx);
          const fw = f.hasFace ? 400 : (a.fontKey?.bold ? 700 : 400);
          const fst = f.hasFace || f.cjk ? 'normal' : (a.fontKey?.italic ? 'italic' : 'normal');
          texts.push(`<div class="ann-text${sel}" data-ann-id="${a.id}" contenteditable="false" style="left:${vx}px;top:${vy}px;${rotCss}font-size:${sizePx}px;line-height:1.25;color:${a.color};font-family:${f.css};font-weight:${fw};font-style:${fst};padding:0;white-space:pre">${esc(r.cur)}</div>`);
        }
      }
    } else if (a.type === 'rect') {
      shapes += `<rect data-ann-id="${a.id}" class="ann-shape${sel}" ${vrect(a.x1, a.y1, a.x2, a.y2)} fill="none" stroke="${a.color}" stroke-width="${(a.sw || 2) * sc}"/>`;
    } else if (a.type === 'ink') {
      const pts = a.points.map(p => { const [vx, vy] = tl(p); return `${vx},${vy}`; }).join(' ');
      shapes += `<polyline data-ann-id="${a.id}" class="ann-shape${sel}" points="${pts}" fill="none" stroke="${a.color}" stroke-width="${(a.sw || 2.5) * sc}" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else if (a.type === 'text') {
      const [vx, vy] = tl([a.x1, a.y2]);
      texts.push(`<div class="ann-text${sel}" data-ann-id="${a.id}" contenteditable="false" style="left:${vx}px;top:${vy}px;transform-origin:0 0;transform:rotate(${rot}deg);font-size:${a.size * sc}px;color:${a.color}">${esc(a.text || '')}</div>`);
    }
  }
  layer.querySelector('svg').innerHTML = shapes;
  layer.querySelectorAll('.ann-text').forEach(el => el.remove());
  const tdiv = document.createElement('div');
  tdiv.innerHTML = texts.join('');
  while (tdiv.firstChild) layer.appendChild(tdiv.firstChild);
}

function renderAnnotationsBySrc(src) {
  for (let i = 0; i < S.pageOrder.length; i++) {
    if (S.pageOrder[i].src === src && S.views.has(i)) renderAnnotations(i);
  }
}

// ---------------- 工具与交互 ----------------
$('#toolGroup').addEventListener('click', e => {
  const btn = e.target.closest('button[data-tool]');
  if (!btn || btn.disabled) return;
  setTool(btn.dataset.tool);
});
function setTool(t) {
  S.tool = t;
  $$('#toolGroup button[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  viewer.dataset.tool = t;
  hideSelBar();
}
$('#colorGroup').addEventListener('click', e => {
  const btn = e.target.closest('.color-dot');
  if (!btn) return;
  S.color = btn.dataset.color;
  $$('.color-dot').forEach(b => b.classList.toggle('active', b === btn));
  if (S.selectedId) recolorAnn(S.selectedId, btn.dataset.color); // 有选中标注：直接改它的颜色
});
$$('.color-dot')[0].classList.add('active');

// ---------------- 选区浮动工具条（Acrobat 式就地操作） ----------------
// 选中页面文字后，在选区旁弹出"高亮 / 改字"，免去把鼠标搬到顶部工具栏
const selBar = $('#selBar');
let selBarTimer = null;
function hideSelBar() { selBar.hidden = true; }
function maybeShowSelBar() {
  if (S.tool !== 'select' || !S.pdfDoc) { hideSelBar(); return; }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { hideSelBar(); return; }
  const node = sel.anchorNode;
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  if (!el || !el.closest('.textLayer')) { hideSelBar(); return; }
  const rects = [...sel.getRangeAt(0).getClientRects()].filter(r => r.width > 1 && r.height > 1);
  if (!rects.length) { hideSelBar(); return; }
  const r = rects[rects.length - 1];
  const vw = viewerWrap.getBoundingClientRect();
  selBar.hidden = false;
  const bw = selBar.offsetWidth, bh = selBar.offsetHeight;
  let top = r.top - vw.top - bh - 8;
  if (top < 4) top = r.bottom - vw.top + 8; // 上方放不下就放到选区下方
  let left = r.left - vw.left + r.width / 2 - bw / 2;
  left = Math.max(8, Math.min(left, vw.width - bw - 8));
  selBar.style.top = top + 'px';
  selBar.style.left = left + 'px';
}
document.addEventListener('selectionchange', () => {
  clearTimeout(selBarTimer);
  selBarTimer = setTimeout(maybeShowSelBar, 180);
});
selBar.addEventListener('pointerdown', e => e.preventDefault()); // 按下不夺走选区
selBar.addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  hideSelBar();
  if (b.dataset.act === 'copy') { copySelectionText(); return; } // 保留选区，只收起工具条
  if (b.dataset.act === 'hl') selectionToHighlight();
  else if (b.dataset.act === 'ul') selectionToTextMark('underline');
  else if (b.dataset.act === 'st') selectionToTextMark('strike');
  else selectionToEditText();
});
viewer.addEventListener('scroll', hideSelBar);

// 高亮 / 改字：把当前文本选区按页分组转成 pdf 坐标矩形
function selectionRectsBySlot() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !pageEls.length) return { sel, bySlot: new Map() };
  const bySlot = new Map(); // slot -> {crects: 屏幕矩形, rects: pdf 矩形}
  for (const r of sel.getRangeAt(0).getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let i = 0; i < pageEls.length; i++) {
      const ir = pageEls[i].querySelector('.page-inner').getBoundingClientRect();
      if (cx >= ir.left && cx <= ir.right && cy >= ir.top && cy <= ir.bottom) {
        const v = S.views.get(i);
        if (!v) break;
        const p1 = v.viewport.convertToPdfPoint(r.left - ir.left, r.top - ir.top);
        const p2 = v.viewport.convertToPdfPoint(r.right - ir.left, r.bottom - ir.top);
        const rect = [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])];
        if (!bySlot.has(i)) bySlot.set(i, { crects: [], rects: [] });
        const e = bySlot.get(i);
        e.crects.push(r);
        e.rects.push(rect);
        break;
      }
    }
  }
  return { sel, bySlot };
}

// 高亮：把当前文本选区转成标注
const btnHighlight = $('button[data-tool="highlight"]');
btnHighlight.addEventListener('mousedown', e => e.preventDefault()); // 保留选区
btnHighlight.addEventListener('click', () => selectionToHighlight());

// 高亮工具激活时：选中文字松开鼠标即高亮，省去再点一次按钮
document.addEventListener('mouseup', e => {
  if (S.tool !== 'highlight' || !S.pdfDoc) return;
  if (e.target && e.target.closest && e.target.closest('#toolbar')) return; // 点高亮按钮走原 click 流程
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const node = sel.anchorNode;
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  if (!el || !el.closest('.textLayer')) return; // 只认页面文字层里的选区
  selectionToHighlight();
});

function selectionToHighlight() { selectionToTextMark('highlight'); }

// 高亮 / 下划线 / 删除线：把当前文本选区按页分组转成标注（同一套"选区 → pdf 矩形"管线）
function selectionToTextMark(type) {
  const { sel, bySlot } = selectionRectsBySlot();
  if (!bySlot.size) { toast('请先用鼠标选中要标记的文字'); return; }
  const added = [];
  for (const [slot, g] of bySlot) {
    const src = S.pageOrder[slot].src;
    const a = { id: 'a' + annSeq++, type, page: src, rects: g.rects, color: S.color };
    if (!S.anns.has(src)) S.anns.set(src, []);
    S.anns.get(src).push(a);
    added.push(a);
    renderAnnotations(slot);
  }
  pushHistoryAdd(added);
  sel.removeAllRanges();
}


// 改字：涂白选中原文并原位替换
const btnEditText = $('#btnEditText');
btnEditText.addEventListener('mousedown', e => e.preventDefault());
btnEditText.addEventListener('click', () => selectionToEditText());

function measureFontSize(sel) {
  const node = sel.anchorNode;
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  const span = el && el.closest ? el.closest('.textLayer span') : null;
  if (span) {
    const fs = parseFloat(getComputedStyle(span).fontSize);
    if (fs > 0) return fs / S.scale;
  }
  return null;
}

// 从画布取样文字颜色（取选区里最深的像素）
function sampleTextColor(slot, cr) {
  const canvas = pageEls[slot].querySelector('canvas');
  const ir = pageEls[slot].querySelector('.page-inner').getBoundingClientRect();
  try {
    const sx = Math.max(0, Math.round((cr.left - ir.left) * DPR));
    const sy = Math.max(0, Math.round((cr.top - ir.top) * DPR));
    const sw = Math.min(300, Math.max(1, Math.round(cr.width * DPR)));
    const sh = Math.max(1, Math.round(cr.height * DPR));
    const d = canvas.getContext('2d').getImageData(sx, sy, sw, sh).data;
    let best = null, bestLum = Infinity;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum < bestLum) { bestLum = lum; best = [d[i], d[i + 1], d[i + 2]]; }
    }
    if (best && bestLum < 210) return '#' + best.map(n => n.toString(16).padStart(2, '0')).join('');
  } catch (e) {}
  return '#1a1a1a';
}

async function selectionToEditText() {
  if (savingPdf) return;
  const generation = S.gen;
  const { sel, bySlot } = selectionRectsBySlot();
  if (!bySlot.size) { toast('请先用鼠标选中要修改的文字'); return; }
  const text = String(sel);
  const added = [];
  const anchorSpan = sel.anchorNode && sel.anchorNode.parentElement?.closest?.('.textLayer span');
  const firstSlot = [...bySlot.keys()][0];
  const fontKey = anchorSpan ? await detectFontStyle(firstSlot, anchorSpan) : { family: 'sans-serif', bold: false, italic: false };
  if (savingPdf || generation !== S.gen) return;
  for (const [slot, g] of bySlot) {
    const src = S.pageOrder[slot].src;
    const size = measureFontSize(sel) || (g.rects[0][3] - g.rects[0][1]) * 0.75;
    const color = sampleTextColor(slot, g.crects[0]);
    const bx1 = Math.min(...g.rects.map(r => r[0])), bx2 = Math.max(...g.rects.map(r => r[2]));
    const by1 = Math.min(...g.rects.map(r => r[1])), by2 = Math.max(...g.rects.map(r => r[3]));
    const m = (slot === firstSlot && anchorSpan) ? await spanItemMetrics(slot, anchorSpan.textContent, by1, by2) : {};
    const faceId = m.fontName ? await ensureEmbeddedFace(src, m.fontName) : null;
    if (savingPdf || generation !== S.gen) return;
    const a = {
      type: 'edit', page: src, x1: bx1, y1: by1, x2: bx2, y2: by2, rects: g.rects,
      text, origText: text, size: m.size || size, color, baselineY: m.baselineY ?? null, fontKey,
      fontName: m.fontName || null, faceId,
    };
    added.push(a);
  }
  // 所有异步字体读取结束后一次加入，避免保存或换文档时留下半组标注。
  for (const a of added) {
    a.id = 'a' + annSeq++;
    if (!S.anns.has(a.page)) S.anns.set(a.page, []);
    S.anns.get(a.page).push(a);
    renderAnnotationsBySrc(a.page);
  }
  pushHistoryAdd(added);
  sel.removeAllRanges();
  selectAnn(added[0].id);
  startEditing(added[0].id); // 直接进入编辑，原文预填
}

function removeAnn(id) {
  for (const [src, list] of S.anns) {
    const idx = list.findIndex(a => a.id === id);
    if (idx !== -1) {
      list.splice(idx, 1);
      if (S.selectedId === id) S.selectedId = null; // 不留指向已删标注的选中态
      renderAnnotationsBySrc(src);
      updateAnnUI();
      refreshDirty();
      return;
    }
  }
}
function pushHistoryAdd(added) {
  // 新增标注类操作（高亮/改字/画形/文字）共用的撤销/重做
  pushHistory({
    undo() { added.forEach(a => removeAnn(a.id)); },
    redo() { readdAnns(added); },
  });
}
function readdAnns(anns) {
  for (const a of anns) {
    if (!S.anns.has(a.page)) S.anns.set(a.page, []);
    S.anns.get(a.page).push(a);
    renderAnnotationsBySrc(a.page);
  }
  updateAnnUI();
}

// 页面上的指针交互（绘制 / 选中拖动 / 平移 / 框选缩放）
// 空格临时手型（设计软件惯例）：按住 Space 拖动平移，松开恢复
let spacePanning = false;
window.addEventListener('blur', () => { spacePanning = false; viewer.classList.remove('space-pan'); });
document.addEventListener('keyup', e => {
  if (e.key === ' ') { spacePanning = false; viewer.classList.remove('space-pan'); }
});
viewer.addEventListener('pointerdown', onPointerDown);

function pdfPointFromEvent(e, slot) {
  const v = S.views.get(slot);
  if (!v) return null;
  const ir = pageEls[slot].querySelector('.page-inner').getBoundingClientRect();
  return v.viewport.convertToPdfPoint(e.clientX - ir.left, e.clientY - ir.top);
}

// 几何命中检测：SVG 标注默认 pointer-events:none（不挡文字选择），
// 未选中的标注点不中 DOM 元素——按点击的 PDF 坐标找最上层包围盒命中的标注
function hitAnnAt(e, slot) {
  const p = pdfPointFromEvent(e, slot);
  if (!p) return null;
  const list = S.anns.get(S.pageOrder[slot]?.src) || [];
  for (let i = list.length - 1; i >= 0; i--) { // 后画的在上层
    const a = list[i];
    const inBox = (x1, y1, x2, y2) => p[0] >= x1 && p[0] <= x2 && p[1] >= y1 && p[1] <= y2;
    if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') {
      if (a.rects.some(r => inBox(r[0], r[1], r[2], r[3]))) return { dataset: { annId: a.id } };
    } else if (a.type === 'ink') {
      // 折线：点到任一线段的距离小于线宽/2 + 余量即命中
      const th = (a.sw || 2.5) / 2 + 2;
      for (let k = 1; k < a.points.length; k++) {
        const [x1, y1] = a.points[k - 1], [x2, y2] = a.points[k];
        const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((p[0] - x1) * dx + (p[1] - y1) * dy) / L2)) : 0;
        if (Math.hypot(p[0] - (x1 + t * dx), p[1] - (y1 + t * dy)) <= th) return { dataset: { annId: a.id } };
      }
    } else if (inBox(a.x1, a.y1, a.x2, a.y2)) { // rect / edit / text 都是包围盒
      return { dataset: { annId: a.id } };
    }
  }
  return null;
}

function onPointerDown(e) {
  if (e.button !== 0 || !S.pdfDoc) return;
  // 手型工具 / 按住空格：拖动平移（页面之外的灰色区域也能拖）
  if (S.tool === 'hand' || spacePanning) {
    e.preventDefault();
    startPan(e);
    return;
  }
  const pageEl = e.target.closest('.page');
  if (!pageEl) return;
  const slot = +pageEl.dataset.slot;
  const annEl = e.target.closest('[data-ann-id]');
  const editing = e.target.closest('.ann-text[contenteditable="true"]');

  // Ctrl+拖拽：框选区域放大（Acrobat 式 marquee zoom）
  if (e.ctrlKey && S.tool === 'select' && !editing) {
    e.preventDefault();
    startMarqueeZoom(e);
    return;
  }

  // 编辑文字模式：点击文字行原地编辑（类似福昕）
  if (S.tool === 'edittext') {
    if (editing) return; // 正在编辑的文本框内正常操作光标
    e.preventDefault();
    startLineEdit(slot, e);
    return;
  }

  if (S.tool === 'select') {
    if (editing) return;
    // 未选中的 SVG 标注（pointer-events:none）靠几何命中点中
    const hit = annEl || hitAnnAt(e, slot);
    if (hit) {
      selectAnn(hit.dataset.annId);
      startDragAnn(e, slot, hit.dataset.annId);
    } else {
      selectAnn(null);
    }
    return;
  }
  // 编辑中的文本框不响应绘制
  if (editing) return;
  // 高亮工具点在文字上 → 交给原生文本选择
  if (S.tool === 'highlight' && e.target.tagName === 'SPAN' && e.target.closest('.textLayer')) return;
  e.preventDefault();
  startDraw(e, slot);
}

function selectAnn(id) {
  if (S.selectedId === id) return;
  const old = S.selectedId;
  S.selectedId = id;
  if (old) { const s = annSlotOf(old); if (s >= 0 && S.views.has(s)) renderAnnotations(s); }
  if (id) { const s = annSlotOf(id); if (s >= 0 && S.views.has(s)) renderAnnotations(s); }
  updateAnnUI();
}

// 提交当前正在编辑的文本框（blur 触发 commit），避免渲染重建吞掉提交
function finishEditing() {
  if (!S.editingId) return;
  const slot = annSlotOf(S.editingId);
  const el = slot >= 0 ? pageEls[slot]?.querySelector(`.ann-text[data-ann-id="${S.editingId}"]`) : null;
  if (el && el.isContentEditable) el.blur();
}

// 编辑文字模式：把点击位置的整行文字变成可编辑（涂白整行 + 原位替换）
// 找到 span 对应的文本项，取精确基线 y / 字号 / 字体名
// （item.transform = [a,b,c,d,e,f]，f=基线 y，|a|≈字号；fontName = pdf.js 加载的字体 id）
async function spanItemMetrics(slot, spanText, yMin, yMax) {
  try {
    const tc = await getTextContent(S.pageOrder[slot].src);
    const item = tc.items.find(it => it.str && spanText.startsWith(it.str) &&
      it.transform[5] >= yMin - 2 && it.transform[5] <= yMax + 2);
    if (item) {
      return {
        baselineY: item.transform[5],
        size: Math.hypot(item.transform[0], item.transform[1]) || null,
        fontName: item.fontName || null,
      };
    }
  } catch (e) {}
  return {};
}

// 取 PDF 内嵌的原字体程序（pdf.js 渲染时已把字体字节放进 commonObjs），用于原字体绘制
const embeddedFaceCache = new Map(); // fontName -> CSS family id（失败为 null）
function resetEmbeddedCache() { embeddedFaceCache.clear(); }

async function getEmbeddedFontData(src, fontName) {
  if (!fontName) return null;
  try {
    const page = await S.pdfDoc.getPage(src + 1);
    const fo = page.commonObjs.get(fontName); // 未解析时抛错
    if (fo && fo.data && fo.data.length > 0) return fo.data;
  } catch (e) {}
  return null;
}

async function ensureEmbeddedFace(src, fontName) {
  if (!fontName) return null;
  if (embeddedFaceCache.has(fontName)) return embeddedFaceCache.get(fontName);
  let id = null;
  try {
    const data = await getEmbeddedFontData(src, fontName);
    if (data) {
      id = 'embfont-' + fontName;
      const face = new FontFace(id, data.slice().buffer);
      await face.load();
      document.fonts.add(face);
    }
  } catch (e) { id = null; }
  embeddedFaceCache.set(fontName, id);
  return id;
}


// 重排（run 变长 / 手动换行 / diff 对不上 / 选区改字）：按折行宽度逐词折行，
// 每个折行点一个 run，同 x、基线逐行下移 1.25×字号——与导出 drawText 的 \n 行距、
// 编辑态 div 的 line-height:1.25 一致，编辑态所见 = 导出所得
const measureCtx = document.createElement('canvas').getContext('2d');
function layoutWrapped(ann, text) {
  const r0 = ann.runs?.[0];
  const x = r0 ? r0.x : ann.rects[0][0];
  const baseY = r0 ? r0.baselineY
    : (ann.baselineY != null ? ann.baselineY : ann.rects[0][1] + (ann.rects[0][3] - ann.rects[0][1]) * 0.22);
  const size = (r0 ? r0.size : ann.size) || 12;
  // 折行宽度 = 原行宽（不会压到右侧内容）；要按页宽折改这一行
  const width = Math.max(10, ann.x2 - ann.x1);
  const fontName = r0?.fontName || ann.fontName || null;
  const css = runFaceCss(embeddedFaceCache.get(fontName) || null, ann.fontKey, text, size * S.scale).css;
  measureCtx.font = `${size}px ${css}`; // 与预览同字体栈测量；与导出字体度量或有微小差异，只影响断点位置
  const lines = [];
  for (const para of text.split('\n')) lines.push(...wrapLine(para, t => measureCtx.measureText(t).width <= width));
  ann.runs = lines.map((ln, i) => ({ x, baselineY: baseY - i * size * 1.25, size, fontName, str: ln, cur: ln, gapBefore: false }));
  // a.text 规范为逐行 join（自动折行点落成真实 \n）：编辑态 div（white-space:pre +
  // line-height:1.25）据此还原多行布局 = 所见即所得；重复提交幂等（text === lines.join）
  ann.text = lines.join('\n');
  ann.wrapped = true;
}


async function startLineEdit(slot, e) {
  if (savingPdf) return;
  const generation = S.gen;
  finishEditing();
  const spans = [...pageEls[slot].querySelectorAll('.textLayer span')];
  let spanEl = e.target.closest('.textLayer span');
  if (!spanEl) {
    // 容错：点击落在行间空隙时，吸附竖向最近的 span（9px 内）
    let best = null, bestD = 9;
    for (const s of spans) {
      const r = s.getBoundingClientRect();
      const d = e.clientY < r.top ? r.top - e.clientY : (e.clientY > r.bottom ? e.clientY - r.bottom : 0);
      if (d < bestD) { bestD = d; best = s; }
    }
    spanEl = best;
  }
  if (!spanEl) {
    if (spans.length) toast('请点击文字所在位置');
    else toast('该页没有文字层（扫描件），无法编辑文字');
    return;
  }
  const v = S.views.get(slot);
  const ir = pageEls[slot].querySelector('.page-inner').getBoundingClientRect();
  // 同一行的 span（top 相差 <3px），按左边界排序
  const line = spans
    .filter(s => Math.abs(s.getBoundingClientRect().top - spanEl.getBoundingClientRect().top) < 3)
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  // 整行包围盒（pdf 坐标）
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of line) {
    const r = s.getBoundingClientRect();
    const p1 = v.viewport.convertToPdfPoint(r.left - ir.left, r.top - ir.top);
    const p2 = v.viewport.convertToPdfPoint(r.right - ir.left, r.bottom - ir.top);
    x1 = Math.min(x1, p1[0], p2[0]); y1 = Math.min(y1, p1[1], p2[1]);
    x2 = Math.max(x2, p1[0], p2[0]); y2 = Math.max(y2, p1[1], p2[1]);
  }
  // 字号兜底放在整行包围盒之后（y1/y2 已定义；提前引用会触发 TDZ ReferenceError）
  const size0 = parseFloat(getComputedStyle(spanEl).fontSize) / S.scale || (y2 - y1) * 0.75;
  const src = S.pageOrder[slot].src;
  // 已有覆盖该行的改字标注 → 直接再编辑，不重复创建
  const existing = (S.anns.get(src) || []).find(a =>
    a.type === 'edit' && a.x1 < x2 && a.x2 > x1 && a.y1 < y2 && a.y2 > y1);
  if (existing) {
    selectAnn(existing.id);
    startEditing(existing.id, { clickX: e.clientX, clickY: e.clientY });
    return;
  }
  const color = sampleTextColor(slot, spanEl.getBoundingClientRect()); // 从点击的行取样，而不是页面第一个 span
  const fontKey = await detectFontStyle(slot, line[0]);
  const m = await spanItemMetrics(slot, line[0].textContent, y1, y2);
  const faceId = await ensureEmbeddedFace(src, m.fontName);
  // PDF 本质：一行 = 一串各自定位的文字运行（run）。保留运行结构，
  // 提交后按字符 diff 分配回各 run，每个 run 在原位置用原字体重绘。
  const tc = await getTextContent(src);
  if (savingPdf || generation !== S.gen) return;
  const lineItems = tc.items
    .filter(it => it.str && it.transform[5] >= y1 - 3 && it.transform[5] <= y2 + 3 &&
      it.transform[4] >= x1 - 3 && it.transform[4] <= x2 + 3)
    .sort((a, b) => a.transform[4] - b.transform[4]);
  const runs = lineItems.map((it, i) => {
    const prev = i > 0 ? lineItems[i - 1] : null;
    const size = Math.hypot(it.transform[0], it.transform[1]) || m.size || size0;
    const gapBefore = prev ? (it.transform[4] - (prev.transform[4] + prev.width)) > size * 0.18 : false;
    return {
      str: it.str, x: it.transform[4], baselineY: it.transform[5], size,
      fontName: it.fontName || null, gapBefore, cur: it.str,
    };
  });
  // 涂白矩形外扩一点，盖住字形边缘的抗锯齿残留（1pt 不会波及相邻行）
  const wr = [x1, y1 - 1, x2 + 2, y2 + 1];
  const a = {
    id: 'a' + annSeq++, type: 'edit', page: src, x1: wr[0], y1: wr[1], x2: wr[2], y2: wr[3], rects: [wr],
    text: joinRuns(runs), origText: joinRuns(runs), size: m.size || size0, color,
    baselineY: m.baselineY ?? null, fontKey, fontName: m.fontName || null, faceId, runs,
  };
  if (!S.anns.has(src)) S.anns.set(src, []);
  S.anns.get(src).push(a);
  renderAnnotations(slot);
  selectAnn(a.id);
  pushHistoryAdd([a]);
  startEditing(a.id, { clickX: e.clientX, clickY: e.clientY });
}

function startDragAnn(e, slot, id) {
  const ann = annOf(id);
  if (!ann) return;
  const before = JSON.parse(JSON.stringify(ann));
  const start = pdfPointFromEvent(e, slot);
  if (!start) return;
  let moved = false;
  const onMove = ev => {
    const cur = pdfPointFromEvent(ev, slot);
    if (!cur) return;
    const dx = cur[0] - start[0], dy = cur[1] - start[1];
    if (!moved && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    moved = true;
    shiftFrom(ann, before, dx, dy);
    renderAnnotations(slot);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (moved) {
      const after = JSON.parse(JSON.stringify(ann));
      pushHistory({
        undo() { Object.assign(ann, JSON.parse(JSON.stringify(before))); renderAnnotationsBySrc(ann.page); },
        redo() { Object.assign(ann, JSON.parse(JSON.stringify(after))); renderAnnotationsBySrc(ann.page); },
      });
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function shiftFrom(ann, before, dx, dy) {
  ann.x1 = before.x1 + dx; ann.x2 = before.x2 + dx;
  ann.y1 = before.y1 + dy; ann.y2 = before.y2 + dy;
  if (before.rects) ann.rects = before.rects.map(r => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
  if (before.points) ann.points = before.points.map(p => [p[0] + dx, p[1] + dy]);
  // 编辑类标注：基线 / run 位置必须跟着走，否则涂白矩形移动了、替换文字留在原地
  if (before.baselineY != null) ann.baselineY = before.baselineY + dy;
  if (before.runs) ann.runs = before.runs.map(r => ({ ...r, x: r.x + dx, baselineY: r.baselineY + dy }));
}

let drawing = null;

// 手型平移：拖动即滚动（H 工具或按住空格临时使用）
function startPan(e) {
  const sx = e.clientX, sy = e.clientY, sl = viewer.scrollLeft, st = viewer.scrollTop;
  viewer.classList.add('panning');
  const onMove = ev => {
    viewer.scrollLeft = sl - (ev.clientX - sx);
    viewer.scrollTop = st - (ev.clientY - sy);
  };
  const onUp = () => {
    viewer.classList.remove('panning');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// Ctrl+拖拽：屏幕上画虚线框，松开后把框内区域放大到铺满视口并居中
function startMarqueeZoom(e) {
  const box = document.createElement('div');
  box.className = 'marquee-zoom';
  document.body.appendChild(box);
  const place = (x1, y1, x2, y2) => {
    box.style.left = Math.min(x1, x2) + 'px';
    box.style.top = Math.min(y1, y2) + 'px';
    box.style.width = Math.abs(x2 - x1) + 'px';
    box.style.height = Math.abs(y2 - y1) + 'px';
  };
  const sx = e.clientX, sy = e.clientY;
  let ex = sx, ey = sy, moved = false;
  const onMove = ev => {
    ex = ev.clientX; ey = ev.clientY;
    if (Math.abs(ex - sx) + Math.abs(ey - sy) > 4) moved = true;
    place(sx, sy, ex, ey);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    box.remove();
    if (moved) marqueeZoomApply(sx, sy, ex, ey);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
}
function marqueeZoomApply(x1, y1, x2, y2) {
  const vr = viewer.getBoundingClientRect();
  // 屏幕坐标 → 内容坐标（加滚动偏移）
  const cx1 = Math.min(x1, x2) - vr.left + viewer.scrollLeft;
  const cx2 = Math.max(x1, x2) - vr.left + viewer.scrollLeft;
  const cy1 = Math.min(y1, y2) - vr.top + viewer.scrollTop;
  const cy2 = Math.max(y1, y2) - vr.top + viewer.scrollTop;
  const w = cx2 - cx1, h = cy2 - cy1;
  if (w < 8 || h < 8) return;
  const old = S.scale;
  // 框选区域（内容像素 → PDF 单位）铺满视口：受宽/高双重约束取小者，留出边距
  const k = Math.min((viewer.clientWidth - 36) * old / w, (viewer.clientHeight - 52) * old / h);
  setScale(old * k);
  const r = S.scale / old; // setScale 有限幅（0.25–5），按实际生效比例滚动
  viewer.scrollLeft = (cx1 + w / 2) * r - viewer.clientWidth / 2;
  viewer.scrollTop = (cy1 + h / 2) * r - viewer.clientHeight / 2;
}

function startDraw(e, slot) {
  const p = pdfPointFromEvent(e, slot);
  if (!p) return;
  const v = S.views.get(slot);
  const svg = pageEls[slot].querySelector('.annotationLayer svg');
  const tool = S.tool;
  drawing = { slot, tool, start: p, v, svg, last: p, points: [p], ghost: null, moved: false };

  if (tool === 'text') {
    finishEditing();
    const src = S.pageOrder[slot].src;
    const a = { id: 'a' + annSeq++, type: 'text', page: src, x1: p[0], y2: p[1], y1: p[1] - 14 * 1.25, x2: p[0] + 30, size: 14, color: S.color, text: '' };
    if (!S.anns.has(src)) S.anns.set(src, []);
    S.anns.get(src).push(a);
    renderAnnotations(slot);
    selectAnn(a.id);
    setTool('select');
    pushHistoryAdd([a]);
    startEditing(a.id);
    drawing = null;
    return;
  }

  e.preventDefault();
  const target = pageEls[slot].querySelector('.page-inner');
  target.setPointerCapture?.(e.pointerId);
  window.addEventListener('pointermove', onDrawMove);
  window.addEventListener('pointerup', onDrawUp, { once: true });
  window.addEventListener('pointercancel', onDrawCancel, { once: true });

  if (tool === 'rect' || tool === 'highlight') {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    g.setAttribute('fill', tool === 'highlight' ? S.color : 'none');
    if (tool === 'highlight') g.setAttribute('opacity', '0.4');
    else { g.setAttribute('stroke', S.color); g.setAttribute('stroke-width', 2 * v.viewport.scale); }
    svg.appendChild(g);
    drawing.ghost = g;
  } else if (tool === 'ink') {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke', S.color);
    g.setAttribute('stroke-width', 2.5 * v.viewport.scale);
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(g);
    drawing.ghost = g;
  }
}

function onDrawMove(e) {
  if (!drawing) return;
  const p = pdfPointFromEvent(e, drawing.slot);
  if (!p) return;
  drawing.moved = true;
  drawing.last = p;
  if (drawing.tool === 'ink') {
    const lp = drawing.points[drawing.points.length - 1];
    const dx = p[0] - lp[0], dy = p[1] - lp[1];
    if (dx * dx + dy * dy < (1.2 / S.scale) ** 2) return;
    drawing.points.push(p);
    drawing.ghost.setAttribute('points', drawing.points.map(q => {
      const [vx, vy] = drawing.v.viewport.convertToViewportPoint(q[0], q[1]);
      return `${vx},${vy}`;
    }).join(' '));
  } else {
    const a = drawing.start, b = p;
    const [vx, vy] = drawing.v.viewport.convertToViewportPoint(Math.min(a[0], b[0]), Math.max(a[1], b[1]));
    drawing.ghost.setAttribute('x', vx);
    drawing.ghost.setAttribute('y', vy);
    drawing.ghost.setAttribute('width', Math.abs(b[0] - a[0]) * S.scale);
    drawing.ghost.setAttribute('height', Math.abs(b[1] - a[1]) * S.scale);
  }
}

function onDrawCancel() {
  window.removeEventListener('pointermove', onDrawMove);
  const d = drawing;
  drawing = null;
  d?.ghost?.remove();
}

function onDrawUp() {
  window.removeEventListener('pointermove', onDrawMove);
  const d = drawing;
  drawing = null;
  if (!d || !d.moved) { d?.ghost?.remove(); return; }
  const src = S.pageOrder[d.slot].src;
  let a;
  if (d.tool === 'ink') {
    if (d.points.length < 2) { d.ghost.remove(); return; }
    a = { id: 'a' + annSeq++, type: 'ink', page: src, points: d.points, color: S.color, sw: 2.5 };
  } else {
    const p1 = d.start, p2 = d.last || d.points[d.points.length - 1];
    const x1 = Math.min(p1[0], p2[0]), x2 = Math.max(p1[0], p2[0]);
    const y1 = Math.min(p1[1], p2[1]), y2 = Math.max(p1[1], p2[1]);
    if (x2 - x1 < 1 || y2 - y1 < 1) { d.ghost.remove(); return; }
    a = d.tool === 'highlight'
      ? { id: 'a' + annSeq++, type: 'highlight', page: src, rects: [[x1, y1, x2, y2]], color: S.color }
      : { id: 'a' + annSeq++, type: 'rect', page: src, x1, y1, x2, y2, color: S.color, sw: 2 };
  }
  if (!S.anns.has(src)) S.anns.set(src, []);
  S.anns.get(src).push(a);
  renderAnnotations(d.slot);
  selectAnn(a.id);
  pushHistoryAdd([a]);
}

// 文本标注编辑（双击）
viewer.addEventListener('dblclick', e => {
  const el = e.target.closest('.ann-text');
  if (!el || S.tool !== 'select') return;
  startEditing(el.dataset.annId);
});

function startEditing(id, opts) {
  const slot = annSlotOf(id);
  if (slot < 0) return;
  const ann = annOf(id);
  // run 结构：必须先置编辑态再重渲染，renderAnnotations 才会切到"整行单编辑框"；
  // 否则渲染的是各 run 的静态框，只有第一个 run 可编辑，提交会把整行截断
  if (ann?.runs) {
    if (!S.views.has(slot)) return;
    S.editingId = id;
    renderAnnotations(slot);
  }
  const el = pageEls[slot]?.querySelector(`.ann-text[data-ann-id="${id}"]`);
  if (!el) return;
  S.editingId = id;
  el.contentEditable = 'plaintext-only';
  if (!el.isContentEditable) el.contentEditable = 'true';
  el.classList.add('editing');
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  // 编辑文字模式：把光标放到用户点击的位置
  if (opts && opts.clickX != null && document.caretRangeFromPoint) {
    const cr = document.caretRangeFromPoint(opts.clickX, opts.clickY);
    if (cr && el.contains(cr.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(cr);
    } else {
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } else {
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const commit = () => {
    el.removeEventListener('blur', commit);
    el.removeEventListener('keydown', onKey);
    el.contentEditable = 'false';
    el.classList.remove('editing');
    const ann = annOf(id);
    if (ann) {
      const text = el.innerText.replace(/\n+$/, '');
      const before = JSON.parse(JSON.stringify(ann));
      if (ann.type === 'edit') {
        // 改字：清空 = 纯涂白（删除原文）；不改包围盒，涂白面积不随新文字缩小
        ann.text = text;
        // 原位保留 run 结构的前提：从未重排过、无手动换行、diff 对得上且没有 run 变长
        //（trim 后比较：run 吸收相邻间隙空格不算变长）；否则整行按折行宽度重排，
        // 每个折行点一个 run，与编辑态所见一致
        if (ann.wrapped || !ann.runs || !ann.runs.length || text.includes('\n') ||
            !alignRunsByDiff(ann, text) ||
            ann.runs.some(r => r.cur.trim().length > r.str.trim().length)) {
          layoutWrapped(ann, text);
        }
        if (text === ann.origText) {
          // 改回原文 = 撤销这次编辑（涂白无意义，移除标注）
          if (before.text !== before.origText) {
            // 此前已有改动的编辑被改回原文：可撤销的移除
            pushHistory({
              undo() { readdAnns([ann]); },
              redo() { removeAnn(ann.id); },
            });
          }
          removeAnn(id);
          S.selectedId = null;
        } else if (text !== before.text) {
          const after = JSON.parse(JSON.stringify(ann));
          pushHistory({
            undo() { Object.assign(ann, JSON.parse(JSON.stringify(before))); renderAnnotationsBySrc(ann.page); },
            redo() { Object.assign(ann, JSON.parse(JSON.stringify(after))); renderAnnotationsBySrc(ann.page); },
          });
        }
        S.editingId = null; // 先退出编辑态，渲染才会走 run 结构分支
        renderAnnotations(slot);
      } else if (!text.trim()) {
        removeAnn(id);
        S.selectedId = null;
      } else {
        ann.text = text;
        const ir = pageEls[slot].querySelector('.page-inner').getBoundingClientRect();
        const r = el.getBoundingClientRect();
        ann.x2 = ann.x1 + r.width / S.scale;
        ann.y1 = ann.y2 - r.height / S.scale;
        const after = JSON.parse(JSON.stringify(ann));
        pushHistory({
          undo() { Object.assign(ann, JSON.parse(JSON.stringify(before))); renderAnnotationsBySrc(ann.page); },
          redo() { Object.assign(ann, JSON.parse(JSON.stringify(after))); renderAnnotationsBySrc(ann.page); },
        });
        renderAnnotations(slot);
      }
    }
    S.editingId = null;
  };
  const onKey = ev => {
    if (ev.key === 'Escape') { ev.stopPropagation(); el.blur(); }
    ev.stopPropagation(); // 阻止全局快捷键
  };
  el.addEventListener('blur', commit);
  el.addEventListener('keydown', onKey);
}

// 删除标注
$('#btnDeleteAnn').addEventListener('click', deleteSelected);
function deleteSelected() {
  if (!S.selectedId) { toast('未选中标注'); return; }
  const ann = annOf(S.selectedId);
  if (!ann) return;
  const src = ann.page;
  const list = S.anns.get(src);
  const idx = list.indexOf(ann);
  list.splice(idx, 1);
  renderAnnotationsBySrc(src);
  S.selectedId = null;
  updateAnnUI();
  refreshDirty();
  pushHistory({
    undo() { list.splice(idx, 0, ann); renderAnnotationsBySrc(src); updateAnnUI(); },
    redo() {
      const i = list.indexOf(ann);
      if (i !== -1) {
        list.splice(i, 1);
        if (S.selectedId === ann.id) { S.selectedId = null; updateAnnUI(); }
        renderAnnotationsBySrc(src);
      }
    },
  });
}

// ---------------- 页面操作 ----------------
async function rotateCurrent(d) {
  const slot = S.currentSlot;
  const slotObj = S.pageOrder[slot];
  if (!slotObj) return;
  slotObj.rot = (slotObj.rot + d + 360) % 360;
  S.slotDims.delete(slot);
  await ensureDims(slot);
  setPageInnerSize(slot);
  if (S.zoomMode === 'fitw') fitWidth(); else if (S.zoomMode === 'fitp') fitPage(); // 旋转改变宽高，适应模式需重算
  renderPage(slot);
  buildThumbs();
  markDirty();
}

async function deletePageAt(slot) {
  if (S.pageOrder.length <= 1) { toast('至少要保留一页'); return; }
  if (!S.pageOrder[slot]) return;
  if (!confirm(`确定删除第 ${slot + 1} 页？（导出后生效，此操作不可撤销）`)) return;
  S.pageOrder.splice(slot, 1);
  markDirty();
  await buildViewer(Math.min(slot, S.pageOrder.length - 1));
  toast('已删除该页（导出时生效）');
}

// ---------------- 缩放 / 翻页 ----------------
$('#btnZoomIn').addEventListener('click', () => setScale(S.scale * 1.2));
$('#btnZoomOut').addEventListener('click', () => setScale(S.scale / 1.2));
function fitWidth() {
  const d = S.slotDims.get(S.currentSlot);
  if (d) setScale((viewer.clientWidth - 36) / d.w, 'fitw');
}
function fitPage() {
  const d = S.slotDims.get(S.currentSlot);
  if (d) setScale(Math.min((viewer.clientWidth - 36) / d.w, (viewer.clientHeight - 52) / d.h), 'fitp');
}
$('#btnSidebar').addEventListener('click', () => $('#sidebar').classList.toggle('collapsed'));
viewer.addEventListener('wheel', e => {
  if (!e.ctrlKey || !S.pdfDoc) return;
  e.preventDefault();
  zoomAtCursor(S.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
}, { passive: false });

// 光标锚点缩放：缩放前后，光标指向的内容点保持在光标下（现代查看器标配）
function zoomAtCursor(v, cx, cy) {
  const vr = viewer.getBoundingClientRect();
  const ox = cx - vr.left + viewer.scrollLeft;
  const oy = cy - vr.top + viewer.scrollTop;
  const old = S.scale;
  setScale(v);
  if (S.scale === old) return;
  const r = S.scale / old;
  viewer.scrollLeft += ox * (r - 1);
  viewer.scrollTop += oy * (r - 1);
}
// 适应宽度/页面模式下，窗口尺寸变化自动重新计算
window.addEventListener('resize', () => {
  if (S.zoomMode === 'fitw') fitWidth();
  else if (S.zoomMode === 'fitp') fitPage();
});

let zoomRenderTimer = null;
function updateZoomLabel(v) {
  const el = $('#zoomLabel');
  if (!S.pdfDoc) { el.textContent = '–'; return; }
  el.textContent = S.zoomMode === 'fitw' ? '适应宽度'
    : S.zoomMode === 'fitp' ? '适应页面'
    : Math.round((v ?? S.scale) * 100) + '%';
}
function setScale(v, mode) {
  v = Math.min(5, Math.max(0.25, v));
  S.zoomMode = mode || 'custom';
  updateZoomLabel(v);
  if (Math.abs(v - S.scale) < 1e-6) return;
  S.scale = v;
  // 记住缩放状态（数字或适应模式），下次打开文档沿用
  if (S.pdfDoc) { try { localStorage.setItem('pdf-zoom', S.zoomMode === 'custom' ? String(v) : S.zoomMode); } catch (e) {} }
  pageEls.forEach((_, i) => setPageInnerSize(i));
  // 连续缩放（Ctrl+滚轮）合并为一次重渲染，避免打满串行渲染队列
  clearTimeout(zoomRenderTimer);
  zoomRenderTimer = setTimeout(reRenderStaleViews, 150);
}

// 打开文档时应用记忆的缩放状态（数字 / 适应宽度 / 适应页面）
function applyZoomPref(v) {
  if (v === 'fitw') fitWidth();
  else if (v === 'fitp') fitPage();
  else if (v && !isNaN(parseFloat(v))) setScale(Math.min(5, Math.max(0.25, parseFloat(v))));
}

// ---------------- 下拉菜单（缩放档位 / 页面操作） ----------------
let menuEl = null;
function closeMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('pointerdown', onMenuOutside, true);
  }
}
function onMenuOutside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
function openMenu(anchor, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  for (const it of items) {
    if (it === 'sep') { const s = document.createElement('div'); s.className = 'menu-sep'; m.appendChild(s); continue; }
    const b = document.createElement('button');
    if (it.danger) b.classList.add('danger');
    if (it.checked) b.classList.add('on');
    // 色点项（改色）：圆点代替勾选位；普通项占位勾（选中可见）
    b.innerHTML = it.swatch
      ? `<span class="mdot" style="background:${it.swatch}"></span>` + esc(it.label)
      : '<span class="mcheck">✓</span>' + esc(it.label);
    b.addEventListener('click', () => { closeMenu(); it.onClick(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  // 锚点按钮：贴其下方右对齐；坐标对象（右键菜单）：出现在光标处。都夹在视口内
  const w = m.offsetWidth, h = m.offsetHeight;
  let top, left;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    top = r.bottom + 8; left = r.right - w;
  } else { top = anchor.y + 2; left = anchor.x + 2; }
  m.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + 'px';
  m.style.left = Math.max(8, Math.min(left, window.innerWidth - w - 8)) + 'px';
  menuEl = m;
  setTimeout(() => document.addEventListener('pointerdown', onMenuOutside, true), 0);
}
$('#btnZoomMenu').addEventListener('click', () => {
  openMenu($('#btnZoomMenu'), [
    ...[50, 75, 100, 125, 150, 200].map(p => ({
      label: p + '%',
      checked: S.zoomMode === 'custom' && Math.abs(S.scale * 100 - p) < 0.5,
      onClick: () => setScale(p / 100),
    })),
    'sep',
    { label: '适应宽度', checked: S.zoomMode === 'fitw', onClick: fitWidth },
    { label: '适应页面', checked: S.zoomMode === 'fitp', onClick: fitPage },
  ]);
});
$('#btnMore').addEventListener('click', () => {
  openMenu($('#btnMore'), [
    { label: '向左旋转当前页', onClick: () => rotateCurrent(-90) },
    { label: '向右旋转当前页', onClick: () => rotateCurrent(90) },
    'sep',
    { label: '删除当前页…', danger: true, onClick: () => deletePageAt(S.currentSlot) },
    'sep',
    ...(TAURI ? [{ label: '保存（写回原文件，Ctrl+S）', onClick: saveInPlace }] : []),
    { label: '打印…', onClick: printPdf },
    { label: '快捷键说明', onClick: () => $('#shortcutHelp').showModal() },
  ]);
});
$('#btnHelpClose').addEventListener('click', () => $('#shortcutHelp').close());

// ---------------- 右键上下文菜单（商业阅读器标配：标注 / 选区 / 页面三套） ----------------
const ANN_COLORS = [
  { name: '黄色', hex: '#f6d743' }, { name: '绿色', hex: '#7bd389' },
  { name: '红色', hex: '#e5604c' }, { name: '蓝色', hex: '#5b9bd5' },
];
document.addEventListener('contextmenu', e => {
  if (!S.pdfDoc) return; // 无文档：不接管浏览器默认菜单
  const pageEl = e.target.closest('.page');
  let annEl = e.target.closest('[data-ann-id]');
  if (!annEl && pageEl) { const h = hitAnnAt(e, +pageEl.dataset.slot); if (h) annEl = h; } // 几何命中未选中的标注
  if (e.target.closest('.ann-text[contenteditable="true"]')) return; // 编辑框内保留原生菜单（复制/粘贴）
  if (!pageEl && !annEl) return; // 工具栏 / 侧栏等页面外区域保留原生菜单
  e.preventDefault();
  closeMenu(); hideSelBar();

  if (annEl) { // 标注：改色 / 删除
    const id = annEl.dataset.annId;
    const ann = annOf(id);
    if (!ann) return;
    selectAnn(id);
    openMenu({ x: e.clientX, y: e.clientY }, [
      ...ANN_COLORS.map(c => ({
        label: c.name, swatch: c.hex, checked: ann.color === c.hex,
        onClick: () => recolorAnn(id, c.hex),
      })),
      'sep',
      { label: '删除标注（Del）', danger: true, onClick: deleteSelected },
    ]);
    return;
  }

  // 文字选区（右键点在选区范围内）：复制 / 高亮 / 改字；点在选区外走页面菜单
  const sel = window.getSelection();
  const anchorEl = sel?.anchorNode ? (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode) : null;
  if (sel && !sel.isCollapsed && anchorEl?.closest('.textLayer') && sel.rangeCount &&
      [...sel.getRangeAt(0).getClientRects()].some(r =>
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)) {
    openMenu({ x: e.clientX, y: e.clientY }, [
      { label: '复制', onClick: copySelectionText },
      'sep',
      { label: '高亮', onClick: selectionToHighlight },
      { label: '下划线', onClick: () => selectionToTextMark('underline') },
      { label: '删除线', onClick: () => selectionToTextMark('strike') },
      { label: '改字…', onClick: selectionToEditText },
    ]);
    return;
  }

  // 页面：旋转 / 删除 / 打印（对右键所在的页生效，不一定是滚动位置当前页）
  const slot = +pageEl.dataset.slot;
  openMenu({ x: e.clientX, y: e.clientY }, [
    { label: '向左旋转本页', onClick: () => rotateSlot(slot, -90) },
    { label: '向右旋转本页', onClick: () => rotateSlot(slot, 90) },
    'sep',
    { label: '删除本页…', danger: true, onClick: () => deletePageAt(slot) },
    'sep',
    { label: '打印…', onClick: printPdf },
  ]);
});

// 改标注颜色（可撤销）
function recolorAnn(id, color) {
  const ann = annOf(id);
  if (!ann || ann.color === color) return;
  const before = ann.color;
  ann.color = color;
  renderAnnotationsBySrc(ann.page);
  pushHistory({
    undo() { ann.color = before; renderAnnotationsBySrc(ann.page); },
    redo() { ann.color = color; renderAnnotationsBySrc(ann.page); },
  });
}

// 复制文字：优先剪贴板 API，失败回退 execCommand（老 WebView 兼容）
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}
function copySelectionText() {
  const text = String(window.getSelection() || '');
  if (!text) return;
  copyText(text).then(ok => toast(ok ? '已复制' : '复制失败'));
}

// 缩放后重渲染"viewport 比例已过期"的已渲染页。
// IO 只在跨越可见性阈值时触发，持续可见的页缩放后不会自己重渲染（canvas 停在旧比例）
function reRenderStaleViews() {
  for (const [slot, v] of [...S.views]) {
    if (v.viewport.scale !== S.scale) {
      cancelRender(slot);
      S.views.delete(slot);
    }
  }
  refreshVisible();
}

$('#btnPrev').addEventListener('click', () => jumpToSlot(S.currentSlot - 1, true));
$('#btnNext').addEventListener('click', () => jumpToSlot(S.currentSlot + 1, true));
$('#pageInput').addEventListener('change', e => {
  const v = Math.min(S.pageOrder.length, Math.max(1, +e.target.value || 1));
  jumpToSlot(v - 1);
});
function jumpToSlot(i, smooth) {
  i = Math.min(S.pageOrder.length - 1, Math.max(0, i));
  if (pageEls[i]) viewer.scrollTo({ top: Math.max(0, pageEls[i].offsetTop - 8), behavior: smooth ? 'smooth' : 'auto' });
  updateCurrent();
}
viewer.addEventListener('scroll', () => requestAnimationFrame(updateCurrent));
function updateCurrent() {
  if (!pageEls.length) return;
  const st = viewer.scrollTop + viewer.clientHeight * 0.35;
  let cur = 0;
  for (let i = 0; i < pageEls.length; i++) {
    if (pageEls[i].offsetTop <= st) cur = i; else break;
  }
  if (cur !== S.currentSlot) {
    S.currentSlot = cur;
    updatePageUI();
  }
}
function updatePageUI() {
  $('#pageInput').value = S.currentSlot + 1;
  $('#pageTotal').textContent = '/ ' + S.pageOrder.length;
  // 状态透明：首/末页时翻页按钮不可点（pdf.js 同款反馈）
  $('#btnPrev').disabled = S.currentSlot <= 0;
  $('#btnNext').disabled = S.currentSlot >= S.pageOrder.length - 1;
  $$('#tab-thumbs .thumb').forEach((t, i) => t.classList.toggle('current', i === S.currentSlot));
  $('#tab-thumbs .thumb.current')?.scrollIntoView({ block: 'nearest' });
}

// ---------------- 缩略图 ----------------
let thumbsGen = 0;
async function buildThumbs() {
  const gen = ++thumbsGen; // 重入保护：快速连续旋转/删页时旧循环立即让位，避免缩略图重复
  const box = $('#tab-thumbs');
  const keepScroll = box.scrollTop; // 旋转单页重建列表时，不要把滚动位置重置回顶部
  box.textContent = '';
  // 先把整列骨架立起来（占位画布 + 页码），当前页蓝框立即出现，
  // 缩略图再进串行队列逐个渲染——避免打开文档后侧栏长时间一片空白
  const els = [];
  for (let i = 0; i < S.pageOrder.length; i++) {
    const thumb = document.createElement('div');
    thumb.className = 'thumb loading';
    thumb.dataset.slot = i;
    thumb.draggable = true;
    thumb.innerHTML = '<canvas width="160" height="226"></canvas><div class="pnum">' + (i + 1) + '</div>' +
      '<div class="tbtns"><button data-act="rl" title="左旋">↺</button><button data-act="rr" title="右旋">↻</button><button data-act="del" title="删除">✕</button></div>';
    box.appendChild(thumb);
    els.push(thumb);
    thumb.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (b) {
        e.stopPropagation();
        if (b.dataset.act === 'del') deletePageAt(i);
        else rotateSlot(i, b.dataset.act === 'rl' ? -90 : 90);
        return;
      }
      jumpToSlot(i);
    });
    thumb.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', String(i)));
    thumb.addEventListener('dragover', e => { e.preventDefault(); thumb.classList.add('dragover'); });
    thumb.addEventListener('dragleave', () => thumb.classList.remove('dragover'));
    thumb.addEventListener('drop', e => {
      e.preventDefault();
      thumb.classList.remove('dragover');
      const from = +e.dataTransfer.getData('text/plain');
      if (!isNaN(from) && from !== i) moveSlot(from, i);
    });
  }
  updatePageUI();
  box.scrollTop = keepScroll;
  for (let i = 0; i < S.pageOrder.length; i++) {
    if (gen !== thumbsGen) return;
    const slotObj = S.pageOrder[i];
    // 渲染缩略图（进串行队列 + 超时保护，卡死则跳过该缩略图）
    try {
      const page = await S.pdfDoc.getPage(slotObj.src + 1);
      const rot = (page.rotate + slotObj.rot) % 360;
      const v1 = page.getViewport({ scale: 1, rotation: rot });
      const ts = Math.min(160 / v1.width, 0.42);
      const vp = page.getViewport({ scale: ts, rotation: rot });
      const c = els[i].querySelector('canvas');
      c.width = Math.floor(vp.width * DPR);
      c.height = Math.floor(vp.height * DPR);
      c.style.height = Math.floor(vp.height) + 'px';
      let thumbTask = null;
      await enqueueRender(async () => {
        thumbTask = page.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: DPR !== 1 ? [DPR, 0, 0, DPR, 0, 0] : undefined });
        await Promise.race([
          thumbTask.promise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('thumb-timeout')), 15000)),
        ]);
      });
    } catch (err) {
      if (err.message === 'thumb-timeout') console.warn('thumb ' + i + ' 超时，跳过');
      else console.error('thumb', i, err);
    }
    if (gen !== thumbsGen) return;
    els[i].classList.remove('loading');
  }
}
async function rotateSlot(slot, d) {
  const slotObj = S.pageOrder[slot];
  slotObj.rot = (slotObj.rot + d + 360) % 360;
  S.slotDims.delete(slot);
  await ensureDims(slot);
  setPageInnerSize(slot);
  if (slot === S.currentSlot) {
    if (S.zoomMode === 'fitw') fitWidth(); else if (S.zoomMode === 'fitp') fitPage();
  }
  renderPage(slot);
  buildThumbs();
  markDirty();
}
async function moveSlot(from, to) {
  const [s] = S.pageOrder.splice(from, 1);
  S.pageOrder.splice(to, 0, s);
  const cur = S.currentSlot;
  await buildViewer(cur);
  markDirty();
  toast(`已把第 ${from + 1} 页移到第 ${to + 1} 页（导出时生效）`);
}

// ---------------- 目录 ----------------
async function loadOutline() {
  const box = $('#tab-outline');
  try {
    const outline = await S.pdfDoc.getOutline();
    if (!outline || !outline.length) { box.innerHTML = '<div class="muted pad">无目录</div>'; return; }
    box.textContent = '';
    const ul = document.createElement('ul');
    const addItems = async (items, depth) => {
      for (const it of items) {
        const li = document.createElement('li');
        li.textContent = it.title || '(无标题)';
        li.style.paddingLeft = 12 + depth * 14 + 'px';
        li.addEventListener('click', async () => {
          const src = await destToSrc(it.dest);
          const slot = S.pageOrder.findIndex(s => s.src === src);
          if (slot >= 0) jumpToSlot(slot); else toast('该目录指向的页面已被删除');
        });
        ul.appendChild(li);
        if (it.items && it.items.length) await addItems(it.items, depth + 1);
      }
    };
    await addItems(outline, 0);
    box.appendChild(ul);
  } catch (e) {
    box.innerHTML = '<div class="muted pad">无目录</div>';
  }
}
async function destToSrc(dest) {
  try {
    const d = typeof dest === 'string' ? await S.pdfDoc.getDestination(dest) : dest;
    if (!Array.isArray(d) || !d[0]) return -1;
    return await S.pdfDoc.getPageIndex(d[0]);
  } catch (e) { return -1; }
}


// ---------------- 侧栏 tab ----------------
$$('.side-tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(name) {
  $$('.side-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.side-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}


// ---------------- 键盘 ----------------
document.addEventListener('keydown', e => {
  if (savingPdf) { e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    const sb = $('#searchBox');
    if (!sb.disabled) { sb.focus(); sb.select(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
    e.preventDefault(); // 拦截浏览器打印网页；打印的对象应始终是 PDF 本身
    if (S.pdfDoc) printPdf();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); // 拦截浏览器"保存网页"；桌面版写回原文件，浏览器版走另存为
    if (S.pdfDoc) { if (TAURI) saveInPlace(); else exportPdf(); }
    return;
  }
  const t = e.target;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
  if (e.key === 'F1') { e.preventDefault(); $('#shortcutHelp').showModal(); return; }
  if (e.key === 'Escape' && menuEl) { closeMenu(); return; }
  // 空格按住 = 临时手型（默认的空格滚动让位给拖动平移）
  if (e.key === ' ' && S.pdfDoc) {
    e.preventDefault();
    spacePanning = true;
    viewer.classList.add('space-pan');
    return;
  }
  if (!S.pdfDoc) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { if (S.selectedId) { e.preventDefault(); deleteSelected(); } }
  else if (e.key === 'Escape') {
    closeMenu(); hideSelBar();
    selectAnn(null);
    if (S.tool !== 'select') setTool('select');
  }
  else if (e.key === 'Home') { e.preventDefault(); jumpToSlot(0); }
  else if (e.key === 'End') { e.preventDefault(); jumpToSlot(S.pageOrder.length - 1); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoNext(); else undoLast();
  }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redoNext(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setScale(S.scale * 1.2); }
  else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setScale(S.scale / 1.2); }
  else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); jumpToSlot(S.currentSlot - 1, true); }
  else if (e.key === 'PageDown' || e.key === 'ArrowRight') { e.preventDefault(); jumpToSlot(S.currentSlot + 1, true); }
  else if (!e.ctrlKey && !e.metaKey && (e.key === 'h' || e.key === 'H')) { setTool('hand'); }
  else if (!e.ctrlKey && !e.metaKey && (e.key === 'v' || e.key === 'V')) { setTool('select'); }
});

// 初始
document.documentElement.dataset.theme = localStorage.getItem('pdf-theme') || 'dark';
$('#btnTheme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('pdf-theme', next);
});
setScale(1.2);
viewer.dataset.tool = 'select';

// 开发/测试直开：?file=/test/sample.pdf（同源 fetch；正式入口仍是打开按钮/拖拽/最近打开）
(() => {
  const m = location.search.match(/[?&]file=([^&]+)/);
  if (!m) return;
  fetch(decodeURIComponent(m[1])).then(r => r.ok ? r.arrayBuffer() : null).then(buf => {
    if (!buf) return;
    const name = decodeURIComponent(m[1]).split('/').pop();
    openFile(new File([buf], name, { type: 'application/pdf' }));
  }).catch(() => {});
})();
