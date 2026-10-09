// 桌面版端到端验证（CDP 驱动 WebView2，无头无依赖）
// 用法：
//   1) npm run tauri -- build --debug --no-bundle --config test/tauri-e2e.json
//   2) WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动 src-tauri/target/debug/pdfpro.exe
//   3) node test/desktop-e2e.mjs（会关闭测试实例）
import { cpSync, existsSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
// openPath 在 WebView 里需要磁盘绝对路径；统一正斜杠，便于与 S.srcPath 回读值比较
const ROOT = resolve(__dirname, '..').replace(/\\/g, '/');
cpSync(join(__dirname, 'sample.pdf'), join(__dirname, 'tmp-write-test.pdf')); // 写回测试副本
// .bak 只在不存在时由 Rust 侧创建：上次运行残留的备份会让"首次备份"检查拿到旧夹具字节
rmSync(join(__dirname, 'tmp-write-test.pdf.bak'), { force: true });
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findPageWs(retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const tabs = await (await fetch(BASE + '/json')).json();
      const page = tabs.find(t => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* exe 可能还没起来 */ }
    await sleep(500);
  }
  throw new Error('app page not found on CDP ' + BASE);
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    return r.result.value;
  }
  mouse(type, x, y, button = 'left', count = 1) {
    return this.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: count });
  }
  async click(selector, text = '') {
    const point = await this.eval(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find(element => element.textContent.includes(${JSON.stringify(text)}));
      const rect = element?.getBoundingClientRect();
      return rect?.width && rect.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    if (!point) throw new Error('点击目标不可见：' + selector + ' ' + text);
    await this.mouse('mousePressed', point.x, point.y);
    await this.mouse('mouseReleased', point.x, point.y);
  }
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log((ok ? '✓' : '✗') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!ok) process.exitCode = 1;
};

const ws = new WebSocket(await findPageWs());
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = new Cdp(ws);
const waitFor = async (expression, timeoutMs = 10000) => {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 200) {
    if (await cdp.eval(expression)) return true;
    await sleep(200);
  }
  return false;
};
const screenshot = async name => {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(__dirname, 'shot-desktop-' + name + '.png'), Buffer.from(result.data, 'base64'));
};
const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers });
  }
};

// 1. 环境就绪：Tauri 全局 + pdf.js + 应用加载
await cdp.eval('Promise.all([document.fonts ? 1 : 1, new Promise(r => (S.pdfDoc || document.readyState === "complete") && r())]').catch(() => {});
await sleep(1000);
check('Tauri 环境可用', await cdp.eval('!!window.__TAURI__ && TAURI === true'));
check('pdf.js 已加载', await cdp.eval('!!window.pdfjsLib'));

const dataPath = await cdp.eval('window.__TAURI__.path.appLocalDataDir()');
if (!dataPath.replace(/\\/g, '/').toLowerCase().startsWith(ROOT.toLowerCase() + '/src-tauri/target/')) {
  ws.close();
  throw new Error('拒绝清除日常会话：请先用 test/tauri-e2e.json 构建隔离测试实例');
}

// 清掉上次运行留下的会话（IndexedDB 跨进程持久——桌面版崩溃恢复即依赖此），保证断言基数确定
// 先重载清掉内存文档，避免 openPath 在切换文件时把审计留下的标注重新写回。
await cdp.send('Page.reload');
if (!await waitFor(`typeof toolbarPrefs !== 'undefined' && document.readyState === 'complete'`)) {
  throw new Error('桌面测试初始化未就绪');
}
await cdp.eval(`(async () => {
  for (const k of await idbKeys()) await idbDel(k);
  localStorage.clear(); setReading(false); setSimple(true); updateToolbarPreferences(DEFAULT_TOOLBAR_TOOLS);
  clearSearch(); document.getElementById('sidebar').classList.add('collapsed'); switchTab('thumbs');
  return true;
})()`);
await sleep(300);

// 2. 按路径打开测试 PDF（worker + cmaps 在 asset 协议下运行）
const okOpen = await cdp.eval(`openPath('${ROOT}/test/sample.pdf')`);
await sleep(2500);
const st1 = await cdp.eval(`({ doc: S.docName, pages: S.pageOrder.length, path: S.srcPath,
  rendered: document.querySelectorAll('.page canvas').length })`);
check('openPath 打开文档', okOpen && st1.doc === 'sample.pdf' && st1.pages === 20, JSON.stringify(st1));
await cdp.eval('renderRecents()');
check('桌面最近文件列表', await cdp.eval('!document.getElementById("recentBox").hidden && document.querySelectorAll(".recent-item").length > 0'));

// 2a. 在实际 WebView2 验证简洁工具栏；只改测试实例偏好，不触碰日常会话。
check('桌面默认简洁工具栏与收起侧栏', await cdp.eval(`(() => {
  const visible = id => document.getElementById(id).getBoundingClientRect().width > 0;
  return document.body.classList.contains('simple') && toolbarPrefs.join(',') === 'search,export' &&
    getComputedStyle(document.getElementById('subbar')).display === 'none' &&
    document.getElementById('sidebar').classList.contains('collapsed') &&
    ['btnOpen', 'pageInput', 'btnZoomMenu', 'searchBox', 'btnSave', 'btnMore'].every(visible) &&
    !document.querySelector('button[data-tool="ink"]').getBoundingClientRect().width;
})()`));
await screenshot('simple');
await cdp.click('#btnMore');
await cdp.click('.menu button', '自定义');
check('桌面更多打开自定义窗口', await cdp.eval('document.getElementById("toolbarCustomize").open'));
const windowPosition = await cdp.eval('({ x: screenX, y: screenY })');
for (const id of ['search', 'export', 'ink']) await cdp.click(`#toolbarChoices input[value="${id}"]`);
const customized = await cdp.eval(`({ prefs: toolbarPrefs.join(','), stored: localStorage.getItem('pdf-toolbar-tools'),
  pinned: !!document.querySelector('#toolFavorites button[data-tool="ink"]'),
  searchHidden: !document.getElementById('searchBox').getBoundingClientRect().width,
  exportHidden: !document.getElementById('btnSave').getBoundingClientRect().width,
  x: screenX, y: screenY })`);
check('桌面真实勾选即时生效并记忆', customized.prefs === 'ink' && customized.stored === '["ink"]' &&
  customized.pinned && customized.searchHidden && customized.exportHidden, JSON.stringify(customized));
check('自定义窗口点击不触发标题栏拖动', customized.x === windowPosition.x && customized.y === windowPosition.y);
await screenshot('customize');
await cdp.click('#toolbarCustomize form[method="dialog"] button:not(#btnToolbarDefault)');
check('桌面完成关闭自定义窗口', await cdp.eval('!document.getElementById("toolbarCustomize").open'));
await cdp.send('Page.reload');
await sleep(600);
if (!await waitFor(`typeof toolbarPrefs !== 'undefined' && document.readyState === 'complete'`)) {
  throw new Error('工具栏偏好重载后未就绪');
}
check('桌面重载保留常用工具', await cdp.eval(`toolbarPrefs.join(',') === 'ink' &&
  !!document.querySelector('#toolFavorites button[data-tool="ink"]') && !document.getElementById('btnSave').getBoundingClientRect().width`));
await cdp.eval(`openPath('${ROOT}/test/sample.pdf')`);
if (!await waitFor(`!!S.pdfDoc && S.views.has(0) && !document.getElementById('btnSave').disabled`)) {
  throw new Error('工具栏偏好重载后文档未就绪');
}
await key('f', 'KeyF', 70, 2);
check('桌面 Ctrl+F 显示隐藏搜索并聚焦', await cdp.eval(`document.activeElement === document.getElementById('searchBox') &&
  document.querySelector('.search-wrap').classList.contains('search-open') && document.getElementById('searchBox').getBoundingClientRect().width > 0`));
await cdp.send('Input.insertText', { text: 'fox' });
await key('Enter', 'Enter', 13);
check('桌面隐藏搜索显示结果侧栏', await waitFor(`!searching && searchState.results.length > 0 &&
  !document.getElementById('sidebar').classList.contains('collapsed') && document.getElementById('tab-results').classList.contains('active')`));
await key('Escape', 'Escape', 27);
check('桌面 Esc 收起临时搜索', await cdp.eval(`!document.querySelector('.search-wrap').classList.contains('search-open') &&
  !document.getElementById('searchBox').getBoundingClientRect().width && !searchState.q`));

// 真实菜单走导出合成；取消最后的文件选择，避免无人值守的原生另存框。
const exportFromMenu = await cdp.eval(`(async () => {
  const originalSaveBytes = saveBytes; let saveCalls = 0;
  saveBytes = async () => { saveCalls++; return false; };
  try {
    openMoreMenu('file');
    const button = [...menuEl.querySelectorAll('button')].find(button => button.textContent.trim().endsWith('导出'));
    const enabled = !!button && !button.disabled;
    if (enabled) button.click();
    while (savingPdf) await new Promise(resolve => setTimeout(resolve, 200));
    return { enabled, saveCalls, ready: !savingPdf && !document.body.inert,
      cancelled: document.getElementById('toast').textContent.includes('已取消导出') };
  } finally { saveBytes = originalSaveBytes; closeMenu(); }
})()`);
check('桌面隐藏导出仍可从文件更多执行', exportFromMenu.enabled && exportFromMenu.saveCalls === 1 &&
  exportFromMenu.ready && exportFromMenu.cancelled, JSON.stringify(exportFromMenu));
const saveGuards = await cdp.eval(`(async () => {
  const saveButton = document.getElementById('btnSave');
  const originalBuildExportBytes = buildExportBytes; let builds = 0;
  buildExportBytes = async () => { builds++; throw new Error('未就绪时不应合成 PDF'); };
  try {
    saveButton.disabled = true; openMoreMenu('file');
    const commands = [...menuEl.querySelectorAll('button')].filter(button => /导出|保存（写回/.test(button.textContent));
    const disabled = commands.length === 2 && commands.every(button => button.disabled);
    const notReady = await exportPdf() === false && await saveInPlace() === false;
    closeMenu(); setPdfSaving(true);
    saveButton.disabled = false; // 单独核验 savingPdf 守卫，不依赖按钮禁用状态。
    const busy = await exportPdf() === false && await saveInPlace() === false;
    return { disabled, notReady, busy, builds };
  } finally { buildExportBytes = originalBuildExportBytes; setPdfSaving(false); closeMenu(); }
})()`);
check('桌面保存与导出遵守就绪及忙碌状态', saveGuards.disabled && saveGuards.notReady && saveGuards.busy &&
  saveGuards.builds === 0, JSON.stringify(saveGuards));

await cdp.click('#btnMore');
await cdp.click('.menu button', '标注与改字');
await cdp.click('.menu button', '方框');
check('桌面隐藏工具显示颜色和退出入口', await cdp.eval(`S.tool === 'rect' &&
  document.getElementById('toolContext').getBoundingClientRect().height > 0 &&
  document.getElementById('currentTool').textContent.includes('方框') &&
  document.getElementById('colorGroup').getBoundingClientRect().width > 0 &&
  document.getElementById('btnExitTool').getBoundingClientRect().width > 0`));
await cdp.click('#colorGroup button[data-color="#7bd389"]');
check('桌面隐藏工具可改色', await cdp.eval('S.color') === '#7bd389');
await screenshot('context');
await cdp.click('#btnExitTool');
check('桌面退出工具收起上下文栏', await cdp.eval(`S.tool === 'select' && !document.getElementById('toolContext').getBoundingClientRect().height`));
await key('F9', 'F9', 120);
check('桌面 F9 展开完整栏', await cdp.eval(`!document.body.classList.contains('simple') &&
  !!document.querySelector('#subbar button[data-tool="ink"]') && document.getElementById('searchBox').getBoundingClientRect().width > 0`));
await key('F9', 'F9', 120);
check('桌面 F9 切回保留常用工具', await cdp.eval(`document.body.classList.contains('simple') && toolbarPrefs.join(',') === 'ink' &&
  !!document.querySelector('#toolFavorites button[data-tool="ink"]')`));
await cdp.eval(`updateToolbarPreferences(DEFAULT_TOOLBAR_TOOLS);
  document.getElementById('sidebar').classList.add('collapsed'); switchTab('thumbs');`);
for (const width of [900, 1280]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
  check(width + 'px 桌面工具栏避开窗口按钮', await cdp.eval(`(() => {
    const controls = document.getElementById('winControls').getBoundingClientRect();
    const toolbar = document.getElementById('toolbar');
    return !document.getElementById('winControls').hidden && innerWidth === ${width} &&
      toolbar.scrollWidth <= toolbar.clientWidth + 1 && [...toolbar.querySelectorAll(':scope > .tb-group')]
        .filter(group => group.getBoundingClientRect().width > 0).every(group => group.getBoundingClientRect().right <= controls.left);
  })()`));
}
await cdp.send('Emulation.clearDeviceMetricsOverride');
await cdp.eval(`clearSearch(); document.querySelector('#colorGroup button[data-color="#f6d743"]').click();
  setTool('select'); setReading(false); setSimple(true);
  updateToolbarPreferences(DEFAULT_TOOLBAR_TOOLS); document.getElementById('sidebar').classList.add('collapsed');
  switchTab('thumbs'); setScale(1); viewer.scrollTop = 0; viewer.scrollLeft = 0;`);
if (!await waitFor(`S.views.has(0) && Math.abs(S.views.get(0).viewport.scale - 1) < 0.01`)) {
  throw new Error('工具栏验证收尾后页面缩放未恢复');
}
await sleep(400);

// 3. 画一个方框标注（CDP 真实鼠标事件 → pointer capture 正常）
await cdp.eval(`setTool('rect')`);
const box = await cdp.eval(`(() => { const r = document.querySelector('.page .page-inner').getBoundingClientRect();
  return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.3 }; })()`);
await cdp.mouse('mousePressed', box.x, box.y);
await cdp.mouse('mouseMoved', box.x + 60, box.y + 40);
await cdp.mouse('mouseReleased', box.x + 60, box.y + 40);
await sleep(600);
const anns1 = await cdp.eval(`[...S.anns.values()].flat().map(a => a.type)`);
check('方框标注创建', anns1.length === 1 && anns1[0] === 'rect', JSON.stringify(anns1));

// 4. 等防抖落库 → 刷新页面 → 恢复横幅
await sleep(1300);
await cdp.eval('location.reload()');
await sleep(2500);
const banner = await cdp.eval(`({ visible: !document.getElementById('recoverBox').hidden,
  msg: document.getElementById('recoverMsg').textContent })`);
check('刷新后恢复横幅', banner.visible && /sample\.pdf/.test(banner.msg), banner.msg);

// 5. 继续编辑 → 标注与写回路径都恢复
await cdp.eval(`document.getElementById('btnRecover').click()`);
await sleep(3000);
const st2 = await cdp.eval(`({ anns: [...S.anns.values()].flat().length, types: [...S.anns.values()].flat().map(a => a.type),
  path: S.srcPath, dirty: document.getElementById('btnSave').classList.contains('dirty') })`);
check('继续编辑恢复标注', st2.anns === 1 && st2.types[0] === 'rect', JSON.stringify(st2));
check('恢复后写回路径可用', st2.path === `${ROOT}/test/sample.pdf`, String(st2.path));

// 6. Ctrl+S 写回原文件（在副本上测，不动 sample.pdf）
await cdp.eval(`window.__TEST = openPath('${ROOT}/test/tmp-write-test.pdf')`);
await sleep(2500);
await cdp.eval(`setTool('rect')`);
const box2 = await cdp.eval(`(() => { const r = document.querySelector('.page .page-inner').getBoundingClientRect();
  return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }; })()`);
await cdp.mouse('mousePressed', box2.x, box2.y);
await cdp.mouse('mouseMoved', box2.x + 80, box2.y + 50);
await cdp.mouse('mouseReleased', box2.x + 80, box2.y + 50);
await sleep(600);
// 等写回+重载完成（dirty 变 false）
const waitSaved = async () => {
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if (await cdp.eval("!document.getElementById('btnSave').classList.contains('dirty')")) return true;
  }
  return false;
};
await cdp.eval('saveInPlace()');
await waitSaved();
const saved = await cdp.eval(`({ dirty: document.getElementById('btnSave').classList.contains('dirty'), path: S.srcPath })`);
check('Ctrl+S 写回后 dirty 清除', !saved.dirty, JSON.stringify(saved));

// 6b. 二次写回（P1 回归：写回后状态必须重建，否则二次保存崩溃/重影）
await cdp.eval(`setTool('rect')`);
const box2b = await cdp.eval(`(() => { const r = document.querySelector('.page .page-inner').getBoundingClientRect();
  return { x: r.left + r.width * 0.6, y: r.top + r.height * 0.6 }; })()`);
await cdp.mouse('mousePressed', box2b.x, box2b.y);
await cdp.mouse('mouseMoved', box2b.x + 60, box2b.y + 40);
await cdp.mouse('mouseReleased', box2b.x + 60, box2b.y + 40);
await sleep(500);
await cdp.eval('saveInPlace()');
await waitSaved();
await sleep(500);
const save2 = await cdp.eval(`({ toast: document.getElementById('toast').textContent,
  anns: [...S.anns.values()].flat().length, pages: S.pageOrder.length, path: S.srcPath,
  dirty: document.getElementById('btnSave').classList.contains('dirty'),
  docSize: S.docSize })`);
check('二次写回成功（状态重建）', !/失败/.test(save2.toast) && save2.anns === 0 && save2.pages === 20 && !save2.dirty, JSON.stringify(save2));
// 磁盘核验：两轮写回应恰好烘焙 2 个方框标注（重影则 >2）；docSize 与磁盘一致（P2）
const disk2 = await (async () => {
  const fs = await import('fs');
  const size = fs.statSync(join(__dirname, 'tmp-write-test.pdf')).size;
  const PDFLib = (await import('file://' + join(__dirname, '..', 'vendor', 'pdf-lib.min.js').replace(/\\/g, '/'))).default;
  const doc = await PDFLib.PDFDocument.load(fs.readFileSync(join(__dirname, 'tmp-write-test.pdf')));
  const c = doc.getPage(0).node.Contents();
  let strokes = 0;
  for (const ref of (c instanceof PDFLib.PDFArray ? c.asArray() : [c])) {
    const st = doc.context.lookup(ref);
    if (st instanceof PDFLib.PDFRawStream)
      strokes += (Buffer.from(PDFLib.decodePDFRawStream(st).decode()).toString('latin1').match(/S\n/g) || []).length;
  }
  return { size, strokes };
})();
check('写回烘焙无重影（恰好 2 个标注）', disk2.strokes === 2, JSON.stringify(disk2));
check('写回后 docSize 对齐磁盘（P2）', save2.docSize === disk2.size, `${save2.docSize} vs ${disk2.size}`);
const backup = await import('fs');
check('二次写回仍保留首次备份', backup.readFileSync(join(__dirname, 'tmp-write-test.pdf.bak')).equals(backup.readFileSync(join(__dirname, 'sample.pdf'))));

// 6c. 适应宽度下旋转当前页必须重算缩放（P3 回归）
const rot = await cdp.eval(`(async () => { fitWidth(); await new Promise(r=>setTimeout(r,300));
  const s1 = S.scale; await rotateCurrent(90); await new Promise(r=>setTimeout(r,600));
  const s2 = S.scale; await rotateCurrent(-90); await new Promise(r=>setTimeout(r,400));
  return { s1, s2, mode: S.zoomMode }; })()`);
check('适应宽度下旋转重算缩放', rot.mode === 'fitw' && Math.abs(rot.s2 - rot.s1) > 0.01, JSON.stringify(rot));

// 6d. 全部撤销回到原样 → 未导出标记清除（P3 回归）
const undoClean = await cdp.eval(`(async () => { setTool('rect'); return true; })()`);
const box2c = await cdp.eval(`(() => { const r = document.querySelector('.page .page-inner').getBoundingClientRect();
  return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.3 }; })()`);
await cdp.mouse('mousePressed', box2c.x, box2c.y);
await cdp.mouse('mouseMoved', box2c.x + 40, box2c.y + 30);
await cdp.mouse('mouseReleased', box2c.x + 40, box2c.y + 30);
await sleep(500);
const dirtyState = await cdp.eval(`(async () => {
  const before = document.getElementById('btnSave').classList.contains('dirty');
  undoLast(); await new Promise(r=>setTimeout(r,200));
  const after = document.getElementById('btnSave').classList.contains('dirty');
  return { before, after };
})()`);
check('全部撤销后 dirty 清除', dirtyState.before && !dirtyState.after, JSON.stringify(dirtyState));

// 7. 单实例 + 文件转发：第二个进程带路径启动 → 已运行实例打开该文件、第二进程退出
//（双击 .pdf 文件关联 = 同一条 argv 转发路径，注册表只在安装包里）
const exePath = [
  join(__dirname, '..', 'src-tauri', 'target', 'debug', 'pdfpro.exe'),
  join(__dirname, '..', 'src-tauri', 'target', 'release', 'pdfpro.exe'),
].find(p => existsSync(p));
if (!exePath) { check('找到 pdfpro.exe', false); }
else {
  const beforeDoc = await cdp.eval('S.docName');
  const second = spawn(exePath, [`${ROOT}/test/sample.pdf`], { stdio: 'ignore', detached: true });
  let forwarded = false;
  for (let i = 0; i < 20 && !forwarded; i++) {
    await sleep(500);
    try { forwarded = await cdp.eval('S.docName === "sample.pdf" && S.srcPath !== null'); } catch (e) {}
  }
  check('单实例转发：文件转给已运行实例', forwarded && beforeDoc !== 'sample.pdf',
    `${beforeDoc} → ${await cdp.eval('S.docName')}`);
  await sleep(1500);
  let secondAlive = true;
  try { process.kill(second.pid, 0); } catch (e) { secondAlive = false; }
  check('第二进程自动退出', !secondAlive, `pid ${second.pid}`);
}

// 8. 自绘窗口控制：按钮可见、最大化切换与图标联动、双击标题栏最大化
const wc = await cdp.eval(`({ visible: !document.getElementById('winControls').hidden,
  n: document.querySelectorAll('#winControls button').length,
  drag: document.getElementById('toolbar').hasAttribute('data-tauri-drag-region') })`);
check('窗口控制按钮可见', wc.visible && wc.n === 3 && wc.drag, JSON.stringify(wc));
// 8a. 窗口拖动：拖拽区 mousedown 底层调用 start_dragging，缺授权时静默失败
//（双击最大化走 toggle-maximize 是另一条命令，曾出现"能双击最大化却拖不动"）。
// OS 级拖动循环跟踪物理光标，CDP 合成事件驱动不了，只能验证命令可调用。
const dragOk = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('plugin:window|start_dragging').then(() => true).catch(e => false)`);
check('窗口拖动权限（start_dragging 可调用）', dragOk === true);
const restoredWindow = `window.__TAURI__.window.getCurrentWindow().isMaximized().then(maximized =>
  !maximized && !document.getElementById('winMax').classList.contains('maximized'))`;
await cdp.eval('window.__TAURI__.window.getCurrentWindow().unmaximize()');
if (!await waitFor(restoredWindow)) throw new Error('最大化测试前窗口未还原');
await cdp.eval('window.__TAURI__.window.getCurrentWindow().toggleMaximize()');
const mx = {
  on: await waitFor('window.__TAURI__.window.getCurrentWindow().isMaximized()'),
  icon: await waitFor('document.getElementById("winMax").classList.contains("maximized")'),
};
await cdp.eval('window.__TAURI__.window.getCurrentWindow().toggleMaximize()');
mx.off = await waitFor(restoredWindow);
check('最大化切换与图标联动', mx.on && mx.icon && mx.off, JSON.stringify(mx));
// 双击拖拽区（工具栏顶边留白处）= 最大化/还原（Tauri 内置），真实鼠标双击序列
await cdp.eval('window.__TAURI__.window.getCurrentWindow().unmaximize()');
if (!await waitFor(restoredWindow)) throw new Error('双击测试前窗口未还原');
await cdp.mouse('mousePressed', 640, 4); await cdp.mouse('mouseReleased', 640, 4);
await cdp.mouse('mousePressed', 640, 4, 'left', 2); await cdp.mouse('mouseReleased', 640, 4, 'left', 2);
const dbl = await waitFor('window.__TAURI__.window.getCurrentWindow().isMaximized()');
check('双击标题栏最大化', dbl === true);
await cdp.eval('window.__TAURI__.window.getCurrentWindow().unmaximize()');
if (!await waitFor(restoredWindow)) throw new Error('双击测试后窗口未还原');

// 9. 关闭按钮：干净状态（已保存）直接关闭，进程退出后 CDP 断连
// 单实例转发可能恢复 sample.pdf 的未导出会话；先打开已写回的副本，确保测试干净关闭。
const closingDocument = await cdp.eval(`(async () => ({
  opened: await openPath('${ROOT}/test/tmp-write-test.pdf'), path: S.srcPath, dirty,
  ready: !!S.pdfDoc && !document.getElementById('btnSave').disabled,
}))()`);
if (!closingDocument.opened || closingDocument.path !== `${ROOT}/test/tmp-write-test.pdf` ||
    closingDocument.dirty !== false || !closingDocument.ready) {
  throw new Error('关闭测试文档未就绪或仍有未导出修改：' + JSON.stringify(closingDocument));
}
const expectedPid = process.env.PDFPRO_E2E_PID ? Number(process.env.PDFPRO_E2E_PID) : null;
if (expectedPid !== null && (!Number.isInteger(expectedPid) || expectedPid <= 0)) {
  throw new Error('PDFPRO_E2E_PID 必须是测试实例的有效进程号');
}
const cb = await cdp.eval(`(() => { const r = document.getElementById('winClose').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await cdp.mouse('mousePressed', cb.x, cb.y);
await cdp.mouse('mouseReleased', cb.x, cb.y);
await sleep(2500);
let webviewClosed = false;
let processExited = expectedPid === null;
for (let attempt = 0; attempt < 20 && !(webviewClosed && processExited); attempt++) {
  try {
    const tabs = await (await fetch(BASE + '/json', { signal: AbortSignal.timeout(1500) })).json();
    webviewClosed = !tabs.some(tab => tab.type === 'page' && /index\.html/.test(tab.url));
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') webviewClosed = true;
    else if (error.name !== 'TimeoutError') throw error;
  }
  if (expectedPid !== null) {
    try { process.kill(expectedPid, 0); processExited = false; }
    catch (error) {
      if (error.code === 'ESRCH') processExited = true;
      else throw error;
    }
  }
  if (!(webviewClosed && processExited)) await sleep(200);
}
check(expectedPid === null ? '关闭按钮关闭 WebView' : '关闭按钮退出进程', webviewClosed && processExited,
  expectedPid === null ? '' : `pid ${expectedPid}`);

console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
ws.close();
