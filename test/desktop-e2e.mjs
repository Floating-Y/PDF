// 桌面版端到端验证（CDP 驱动 WebView2，无头无依赖）
// 用法：
//   1) npm run tauri -- build --debug --no-bundle --config test/tauri-e2e.json
//   2) WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动 src-tauri/target/debug/pdfpro.exe
//   3) node test/desktop-e2e.mjs（会关闭测试实例）
import { cpSync, existsSync, rmSync } from 'fs';
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
await cdp.eval('(async () => { for (const k of await idbKeys()) await idbDel(k); return true; })()');
await sleep(300);

// 2. 按路径打开测试 PDF（worker + cmaps 在 asset 协议下运行）
const okOpen = await cdp.eval(`openPath('${ROOT}/test/sample.pdf')`);
await sleep(2500);
const st1 = await cdp.eval(`({ doc: S.docName, pages: S.pageOrder.length, path: S.srcPath,
  rendered: document.querySelectorAll('.page canvas').length })`);
check('openPath 打开文档', okOpen && st1.doc === 'sample.pdf' && st1.pages === 20, JSON.stringify(st1));
await cdp.eval('renderRecents()');
check('桌面最近文件列表', await cdp.eval('!document.getElementById("recentBox").hidden && document.querySelectorAll(".recent-item").length > 0'));

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
const mx = await cdp.eval(`(async () => {
  const w = window.__TAURI__.window.getCurrentWindow();
  await w.toggleMaximize(); await new Promise(r => setTimeout(r, 500));
  const on = await w.isMaximized();
  const icon = document.getElementById('winMax').classList.contains('maximized');
  await w.toggleMaximize(); await new Promise(r => setTimeout(r, 500));
  return { on, icon, off: !(await w.isMaximized()) };
})()`);
check('最大化切换与图标联动', mx.on && mx.icon && mx.off, JSON.stringify(mx));
// 双击拖拽区（工具栏顶边留白处）= 最大化/还原（Tauri 内置），真实鼠标双击序列
await cdp.mouse('mousePressed', 640, 4); await cdp.mouse('mouseReleased', 640, 4);
await cdp.mouse('mousePressed', 640, 4, 'left', 2); await cdp.mouse('mouseReleased', 640, 4, 'left', 2);
await sleep(700);
const dbl = await cdp.eval(`window.__TAURI__.window.getCurrentWindow().isMaximized()`);
check('双击标题栏最大化', dbl === true);
if (dbl) { await cdp.eval(`window.__TAURI__.window.getCurrentWindow().toggleMaximize()`); await sleep(400); }

// 9. 关闭按钮：干净状态（已保存）直接关闭，进程退出后 CDP 断连
const cb = await cdp.eval(`(() => { const r = document.getElementById('winClose').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await cdp.mouse('mousePressed', cb.x, cb.y);
await cdp.mouse('mouseReleased', cb.x, cb.y);
await sleep(2500);
let closed = false;
try { await Promise.race([cdp.eval('1'), new Promise((_, rej) => setTimeout(rej, 1500))]); }
catch (e) { closed = true; }
check('关闭按钮退出进程', closed);

console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
ws.close();
