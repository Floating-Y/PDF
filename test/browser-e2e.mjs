// 浏览器版端到端验证（无头 Chrome/Edge + CDP，零依赖）：自动起 server.js，用 ?file= 直开测试文档
// 用法：node test/browser-e2e.mjs   （结束自动清理进程；需本机装有 Chrome 或 Edge，或设 CHROME 环境变量）
// 覆盖：?file 直开、缩放记忆、手型平移、空格临时平移、Ctrl+拖拽框选缩放、Ctrl+滚轮光标锚点、
//       标注几何命中、色板改色、右键菜单（标注/页面/选区）、橡皮擦。桌面版验证见 desktop-e2e.mjs。
import { spawn } from 'child_process';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 5199, CDP_PORT = 9224;
const APP = `http://127.0.0.1:${PORT}/?file=/test/sample.pdf`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CANDIDATES = [
  process.env.CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const BROWSER = CANDIDATES.find(existsSync);
if (!BROWSER) { console.error('未找到 Chrome/Edge（可设 CHROME 环境变量指定路径）'); process.exit(1); }

const server = spawn(process.execPath, [join(__dirname, '..', 'server.js'), String(PORT)], { stdio: 'ignore' });
await sleep(400);
// 端口被占（上次强杀残留）时 server 会立刻退出——显式报错，不让后续步骤莫名失败
if (server.exitCode !== null) {
  console.error(`server.js 启动失败（端口 ${PORT} 被占用，先杀掉残留进程：netstat -ano | findstr :${PORT}）`);
  process.exit(1);
}
const profile = join(tmpdir(), 'pdfpro-e2e-' + Date.now());
const browser = spawn(BROWSER, [
  '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { if (browser.pid) spawn('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
  try { server.kill(); } catch (e) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log((ok ? '✓' : '✗') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!ok) process.exitCode = 1;
};

try {
  // CDP 就绪 → 打开应用页
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(400);
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const t = tabs.find(x => x.type === 'page');
      if (t) wsUrl = t.webSocketDebuggerUrl;
    } catch (e) {}
  }
  if (!wsUrl) throw new Error('CDP 未就绪');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = {
    id: 0, pending: new Map(),
    send(method, params = {}) {
      return new Promise((res, rej) => {
        const id = ++this.id;
        this.pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async eval(expr) {
      const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
      return r.result.value;
    },
    mouse(type, x, y, button = 'left', count = 1, modifiers = 0) {
      return this.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: count, modifiers });
    },
  };
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && cdp.pending.has(m.id)) {
      const { res, rej } = cdp.pending.get(m.id);
      cdp.pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  // 轮询等待页面表达式为真（缩放重渲染有 150ms 防抖 + 渲染耗时）
  const waitFor = async (expr, ms = 5000) => {
    for (let i = 0; i < ms / 200; i++) {
      if (await cdp.eval(expr)) return true;
      await sleep(200);
    }
    return false;
  };
  // 缩放类用例收尾：回到 100% + 顶部，等第 1 页按当前缩放就绪（否则后续取到的坐标在屏幕外）
  const resetZoom = async () => {
    await cdp.eval('setScale(1); viewer.scrollTop = 0; viewer.scrollLeft = 0;');
    return waitFor('S.views.has(0) && Math.abs(S.views.get(0).viewport.scale - 1) < 0.01');
  };
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: APP });

  let opened = false;
  for (let i = 0; i < 40 && !opened; i++) {
    await sleep(400);
    try { opened = await cdp.eval('!!S.pdfDoc && S.docName === "sample.pdf" && !document.querySelector("#welcome:not(.hidden)")'); } catch (e) {}
  }
  check('?file= 直开文档', opened);
  if (!opened) throw new Error('文档未打开，后续测试无意义');
  await sleep(1500); // 首屏渲染

  // 手型工具按钮在工具条且可用；图标实际渲染出尺寸；两层工具条无溢出/异常换行
  check('手型工具按钮', await cdp.eval('(() => { const b = document.querySelector("#subbar button[data-tool=hand]"); return !!b && !b.disabled; })()'));
  check('手型图标渲染', await cdp.eval('(() => { const r = document.querySelector("#subbar button[data-tool=hand] svg path").getBoundingClientRect(); return r.width > 5 && r.height > 5; })()'));
  check('工具栏无溢出', await cdp.eval('(() => { const t = document.getElementById("toolbar"), s = document.getElementById("subbar"); return t.scrollWidth <= t.clientWidth + 1 && s.scrollWidth <= s.clientWidth + 1 && t.getBoundingClientRect().height < 120 && s.getBoundingClientRect().height < 80; })()'));

  // 缩放状态记忆
  await cdp.eval('setScale(2)');
  check('缩放数值记忆', await cdp.eval('localStorage.getItem("pdf-zoom")') === '2');
  await cdp.eval('fitWidth()');
  check('适应模式记忆', await cdp.eval('localStorage.getItem("pdf-zoom")') === 'fitw');
  await resetZoom();

  // 手型工具拖动平移
  await cdp.eval('setTool("hand")');
  const pan0 = await cdp.eval('viewer.scrollTop');
  await cdp.mouse('mousePressed', 700, 450);
  await cdp.mouse('mouseMoved', 700, 350);
  await cdp.mouse('mouseMoved', 700, 280);
  await cdp.mouse('mouseReleased', 700, 280);
  const pan1 = await cdp.eval('viewer.scrollTop');
  check('手型工具拖动平移', pan1 > pan0 + 80, `${pan0} → ${pan1}`);
  await cdp.eval('setTool("select")');

  // 空格临时平移（合成键盘事件驱动同一代码路径）
  await cdp.eval('document.dispatchEvent(new KeyboardEvent("keydown", {key: " ", bubbles: true, cancelable: true}))');
  check('空格进入临时手型', await cdp.eval('spacePanning === true'));
  const pan2 = await cdp.eval('viewer.scrollTop');
  await cdp.mouse('mousePressed', 700, 400);
  await cdp.mouse('mouseMoved', 760, 460);
  await cdp.mouse('mouseReleased', 760, 460);
  const pan3 = await cdp.eval('viewer.scrollTop');
  check('空格拖动平移', Math.abs(pan3 - pan2) > 40, `${pan2} → ${pan3}`);
  await cdp.eval('document.dispatchEvent(new KeyboardEvent("keyup", {key: " ", bubbles: true}))');
  check('松开空格退出', await cdp.eval('spacePanning === false'));

  // Ctrl+拖拽框选缩放（CDP modifiers: 2 = Ctrl）
  const z0 = await cdp.eval('S.scale');
  const pg = await cdp.eval('(() => { const r = document.querySelector(".page .page-inner").getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.3 }; })()');
  await cdp.mouse('mousePressed', pg.x, pg.y, 'left', 1, 2);
  await cdp.mouse('mouseMoved', pg.x + 90, pg.y + 60, 'left', 1, 2);
  await cdp.mouse('mouseReleased', pg.x + 90, pg.y + 60, 'left', 1, 2);
  const z1 = await cdp.eval('S.scale');
  check('Ctrl+拖拽框选放大', z1 > z0 * 1.8, `${z0.toFixed(2)} → ${z1.toFixed(2)}`);
  await resetZoom();

  // Ctrl+滚轮：放大且光标下的内容点不动。在页宽超出视口（有横向滚动条）的场景下测量——
  // 页面比视口窄时它始终居中、无滚动可言，缩放后重新居中带来的漂移各查看器皆然，不具断言意义
  await cdp.eval('setScale(3)');
  await waitFor('S.views.has(0) && Math.abs(S.views.get(0).viewport.scale - 3) < 0.01');
  const anchor = await cdp.eval(`(() => {
    const r = document.querySelector(".page .page-inner").getBoundingClientRect();
    const vr = document.getElementById("viewer").getBoundingClientRect();
    // 锚点取页面与视口交集内的一点（放大后页面可能比视口大，40% 处已在屏幕外）
    const x = Math.min(Math.max(r.left + r.width * 0.6, vr.left + 60), vr.right - 60);
    const y = Math.min(Math.max(r.top + r.height * 0.4, vr.top + 60), vr.bottom - 60);
    return { x, y };
  })()`);
  const pdfPtAt = () => cdp.eval(`(() => { const r = document.querySelector(".page .page-inner").getBoundingClientRect();
    const d = S.slotDims.get(0); return [(${anchor.x} - r.left) / S.scale, d.h - (${anchor.y} - r.top) / S.scale]; })()`);
  const p0 = await pdfPtAt();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: anchor.x, y: anchor.y, deltaX: 0, deltaY: -240, modifiers: 2 });
  const p1 = await pdfPtAt();
  const zW = await cdp.eval('S.scale');
  check('Ctrl+滚轮放大', zW > 3.1, String(zW.toFixed(2)));
  check('缩放锚点在光标', Math.abs(p1[0] - p0[0]) < 3 && Math.abs(p1[1] - p0[1]) < 3,
    `(${p0.map(v => v.toFixed(1))}) → (${p1.map(v => v.toFixed(1))})`);
  await resetZoom();

  // 标注几何命中 + 色板改色 + 撤销
  await cdp.eval('setTool("rect")');
  const dr = await cdp.eval('(() => { const r = document.querySelector(".page .page-inner").getBoundingClientRect(); return { x: r.left + r.width * 0.35, y: r.top + r.height * 0.4 }; })()');
  await cdp.mouse('mousePressed', dr.x, dr.y);
  await cdp.mouse('mouseMoved', dr.x + 70, dr.y + 45);
  await cdp.mouse('mouseReleased', dr.x + 70, dr.y + 45);
  await sleep(400);
  check('画方框标注', await cdp.eval('[...S.anns.values()].flat().length') === 1);
  await cdp.eval('setTool("select")');
  await cdp.eval('selectAnn(null)'); // 取消选中——几何命中测试的前提（SVG 元素 pointer-events:none）
  await cdp.mouse('mousePressed', dr.x + 35, dr.y + 22);
  await cdp.mouse('mouseReleased', dr.x + 35, dr.y + 22);
  await sleep(200);
  check('未选中标注几何命中', await cdp.eval('!!S.selectedId'));
  await cdp.eval('document.querySelectorAll(".color-dot")[1].click()');
  const col1 = await cdp.eval('[...S.anns.values()].flat()[0].color');
  check('色板改选中标注颜色', col1 === '#7bd389', col1);
  await cdp.eval('undoLast()');
  const col2 = await cdp.eval('[...S.anns.values()].flat()[0].color');
  check('改色可撤销', col2 === '#f6d743', col2);

  // 右键菜单：标注（改色 + 删除）
  await cdp.mouse('mousePressed', dr.x + 35, dr.y + 22, 'right');
  await cdp.mouse('mouseReleased', dr.x + 35, dr.y + 22, 'right');
  await sleep(250);
  let items = await cdp.eval('menuEl ? [...menuEl.querySelectorAll("button")].map(b => b.textContent) : null');
  check('标注右键菜单', !!items && items.some(t => t.includes('删除标注')) && items.some(t => t.includes('红')), JSON.stringify(items));
  check('菜单在视口内', await cdp.eval('menuEl ? menuEl.getBoundingClientRect().right <= innerWidth && menuEl.getBoundingClientRect().bottom <= innerHeight : false'));
  await cdp.eval(`(() => { const b = [...menuEl.querySelectorAll("button")].find(x => x.textContent.includes("红")); if (b) b.click(); return !!b; })()`);
  await sleep(200);
  const col3 = await cdp.eval('[...S.anns.values()].flat()[0].color');
  check('右键菜单改色', col3 === '#e5604c', col3);

  // 橡皮擦：单击删整笔 / 拖动擦局部拆分 / 撤销重做
  await cdp.eval('setTool("ink")');
  const ip = await cdp.eval('(() => { const r = document.querySelector(".page .page-inner").getBoundingClientRect(); return { x: r.left + r.width * 0.25, y: r.top + r.height * 0.78 }; })()');
  await cdp.mouse('mousePressed', ip.x, ip.y);
  for (let i = 1; i <= 12; i++) await cdp.mouse('mouseMoved', ip.x + i * 12, ip.y);
  await cdp.mouse('mouseReleased', ip.x + 144, ip.y);
  await sleep(400);
  const ink1 = await cdp.eval('[...S.anns.values()].flat().filter(a => a.type === "ink").map(a => a.points.length)');
  check('画涂鸦笔画', ink1.length === 1 && ink1[0] === 13, JSON.stringify(ink1));
  const evp = await cdp.eval(`(() => { const a = [...S.anns.values()].flat().find(a => a.type === "ink");
    const slot = S.pageOrder.findIndex(s => s.src === a.page); const v = S.views.get(slot);
    const [vx, vy] = v.viewport.convertToViewportPoint(a.points[6][0], a.points[6][1]);
    const ir = pageEls[slot].querySelector(".page-inner").getBoundingClientRect();
    return { x: Math.round(ir.left + vx), y: Math.round(ir.top + vy) }; })()`);
  await cdp.eval('setTool("erase")');
  await cdp.mouse('mousePressed', evp.x, evp.y);
  await cdp.mouse('mouseReleased', evp.x, evp.y);
  await sleep(300);
  check('橡皮擦单击删整笔', await cdp.eval('[...S.anns.values()].flat().filter(a => a.type === "ink").length') === 0);
  await cdp.eval('undoLast()');
  const ink2 = await cdp.eval('[...S.anns.values()].flat().filter(a => a.type === "ink").map(a => a.points.length)');
  check('整笔删除可撤销', ink2.length === 1 && ink2[0] === 13, JSON.stringify(ink2));
  await cdp.mouse('mousePressed', evp.x, evp.y - 40);
  for (let i = 1; i <= 8; i++) await cdp.mouse('mouseMoved', evp.x + i, evp.y - 40 + i * 10);
  await cdp.mouse('mouseReleased', evp.x + 8, evp.y + 40);
  await sleep(300);
  const ink3 = await cdp.eval('[...S.anns.values()].flat().filter(a => a.type === "ink").map(a => a.points.length)');
  check('橡皮擦拖动擦局部拆分', ink3.length === 2 && ink3[0] + ink3[1] < 13, JSON.stringify(ink3));
  await cdp.eval('undoLast()');
  check('局部擦除可撤销', JSON.stringify(await cdp.eval('[...S.anns.values()].flat().filter(a => a.type === "ink").map(a => a.points.length)')) === JSON.stringify([13]));
  await cdp.eval('redoNext()');
  const ink4 = await cdp.eval('[...S.anns.values()].flat().filter(a => a.type === "ink").map(a => a.points.length)');
  check('局部擦除可重做', ink4.length === 2, JSON.stringify(ink4));
  await cdp.eval('undoLast()'); // 收尾：恢复完整笔画

  // 改字：短行变长吃同栏空间不折行（段落末行/短行场景）；超栏才折行
  const hd = await cdp.eval(`(() => { for (const s of document.querySelectorAll('.textLayer span')) {
    if (/Page 1 of 20/.test(s.textContent)) { const r = s.getBoundingClientRect();
      return { x: r.left + r.width * 0.4, y: r.top + r.height / 2 }; } } return null; })()`);
  check('找到短行标题', !!hd);
  await cdp.eval('setTool("edittext")');
  await cdp.mouse('mousePressed', hd.x, hd.y);
  await cdp.mouse('mouseReleased', hd.x, hd.y);
  await sleep(1200);
  await cdp.eval(`(() => { const el = document.querySelector(".ann-text.editing");
    el.focus(); document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, "Page 111 of 20"); return true; })()`);
  await cdp.eval('document.querySelector(".ann-text.editing").blur()');
  await sleep(500);
  const edit1 = await cdp.eval(`(() => { const a = [...S.anns.values()].flat().find(a => a.type === "edit");
    return { runs: a.runs.map(r => r.cur), wrapped: !!a.wrapped }; })()`);
  check('短行改长不折行', edit1.runs.length === 1 && edit1.runs[0] === 'Page 111 of 20' && !edit1.wrapped, JSON.stringify(edit1));
  await cdp.mouse('mousePressed', hd.x, hd.y);
  await cdp.mouse('mouseReleased', hd.x, hd.y);
  await sleep(1000);
  await cdp.eval(`(() => { const el = document.querySelector(".ann-text.editing");
    el.focus(); document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, "Page 111111 of 20 with a long tail that must wrap to the next line somewhere here"); return true; })()`);
  await cdp.eval('document.querySelector(".ann-text.editing").blur()');
  await sleep(500);
  const edit2 = await cdp.eval(`(() => { const a = [...S.anns.values()].flat().find(a => a.type === "edit");
    return { n: a.runs.length }; })()`);
  check('超栏改字折行', edit2.n >= 2, JSON.stringify(edit2));
  await cdp.eval('removeAnn([...S.anns.values()].flat().find(a => a.type === "edit").id)'); // 收尾：移除改字标注

  // 右键菜单：页面（避开已画标注的区域）
  await cdp.mouse('mousePressed', 830, 500, 'right');
  await cdp.mouse('mouseReleased', 830, 500, 'right');
  await sleep(250);
  items = await cdp.eval('menuEl ? [...menuEl.querySelectorAll("button")].map(b => b.textContent) : null');
  check('页面右键菜单', !!items && items.some(t => t.includes('旋转')) && items.some(t => t.includes('打印')), JSON.stringify(items));
  await cdp.eval('closeMenu()');

  // 右键菜单：文字选区（复制 / 高亮 / 改字）
  const selPt = await cdp.eval(`(() => { const sp = document.querySelector('.textLayer span'); if (!sp) return null;
    const r = document.createRange(); r.selectNodeContents(sp);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    const b = sp.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  check('页面存在文字层', !!selPt);
  if (selPt) {
    await cdp.mouse('mousePressed', selPt.x, selPt.y, 'right');
    await cdp.mouse('mouseReleased', selPt.x, selPt.y, 'right');
    await sleep(250);
    items = await cdp.eval('menuEl ? [...menuEl.querySelectorAll("button")].map(b => b.textContent) : null');
    check('选区右键菜单', !!items && items.some(t => t.includes('复制')) && items.some(t => t.includes('高亮')) && items.some(t => t.includes('下划线')), JSON.stringify(items));
  }
  check('选区工具条含复制按钮', await cdp.eval('!!document.querySelector("#selBar button[data-act=copy]")'));

  // 下划线（选区工具条）+ 含线形标注的导出冒烟（页内 pdf-lib 回读）
  await cdp.eval(`(() => { const sp = document.querySelector('.textLayer span'); const r = document.createRange(); r.selectNodeContents(sp);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return !!sp; })()`);
  await sleep(400); // selectionchange 防抖 180ms 后工具条出现
  await cdp.eval('document.querySelector("#selBar button[data-act=ul]").click()');
  await sleep(200);
  const ulTypes = await cdp.eval('[...S.anns.values()].flat().map(a => a.type)');
  check('选区加下划线', ulTypes.includes('underline'), JSON.stringify(ulTypes));
  const exp = await cdp.eval('(async () => { const b = await buildExportBytes(); const d = await PDFLib.PDFDocument.load(b); return d.getPageCount(); })()');
  check('含下划线的导出冒烟', exp === 20, String(exp));

  // 全文搜索：输入即搜 + 命中计数 + 自动定位第一处
  await cdp.eval(`(() => { const sb = document.getElementById('searchBox'); sb.value = 'fox';
    sb.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(1800); // 防抖 280ms + 全文扫描
  const sr = await cdp.eval('({ n: searchState.results.length, cur: searchState.cur })');
  check('全文搜索出结果并定位', sr.n > 0 && sr.cur === 0, JSON.stringify(sr));

  // 主题切换
  const th0 = await cdp.eval('document.documentElement.dataset.theme');
  await cdp.eval('document.getElementById("btnTheme").click()');
  const th1 = await cdp.eval('document.documentElement.dataset.theme');
  check('主题切换', th0 !== th1 && ['dark', 'light'].includes(th1), `${th0} → ${th1}`);

  // 阅读模式：F8 开 → 工具栏整体滑出（fixed）+ 悬浮页码胶囊同步当前页；F8 关 → 布局还原
  await cdp.eval('document.dispatchEvent(new KeyboardEvent("keydown", {key: "F8", bubbles: true, cancelable: true}))');
  const rd1 = await cdp.eval(`(() => {
    const tb = document.getElementById("topbars");
    return document.body.classList.contains("reading") &&
      getComputedStyle(tb).position === "fixed" &&
      getComputedStyle(document.getElementById("pagePill")).display !== "none" &&
      document.getElementById("pagePillText").textContent === (S.currentSlot + 1) + " / " + S.pageOrder.length;
  })()`);
  check('阅读模式：工具栏滑出 + 页码胶囊', rd1);
  const rd2 = await cdp.eval(`(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "F8", bubbles: true, cancelable: true}));
    return getComputedStyle(document.getElementById("topbars")).position === "relative" &&
      !document.body.classList.contains("reading");
  })()`);
  check('阅读模式退出还原布局', rd2);

  // 真实导出入口：取消选择器仍保留未保存标记及恢复记录。
  const cancelled = await cdp.eval(`(async () => {
    const picker = window.showSaveFilePicker;
    window.showSaveFilePicker = async () => { throw Object.assign(new Error('cancel'), { name: 'AbortError' }); };
    try {
      await saveSession();
      const ok = await exportPdf();
      return { ok, dirty, recoverable: !!(await idbOp('readonly', S.sessionKey)), inert: document.body.inert };
    } finally { window.showSaveFilePicker = picker; }
  })()`);
  check('取消导出保留修改与恢复记录', !cancelled.ok && cancelled.dirty && cancelled.recoverable && !cancelled.inert, JSON.stringify(cancelled));

  // 崩溃恢复（浏览器版路径）：会话落库 → 打开无 ?file= 的欢迎屏 → 横幅 → 继续编辑
  await sleep(1300); // 等会话防抖 800ms 落库（含上面的标注）
  await cdp.eval('clearDirty()'); // 有未导出修改时应用的 beforeunload 确认会挡住导航（无头下无人应答即挂起）；会话已落库，清掉标记安全
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2200);
  const banner = await cdp.eval(`({ visible: !document.getElementById('recoverBox').hidden,
    msg: document.getElementById('recoverMsg').textContent })`);
  check('欢迎屏恢复横幅（浏览器版）', banner.visible && /sample\.pdf/.test(banner.msg), banner.msg);
  await cdp.eval('document.getElementById("btnRecover").click()');
  let rec = null;
  for (let i = 0; i < 12 && !rec; i++) {
    await sleep(500);
    try { rec = await cdp.eval('S.docName === "sample.pdf" ? [...S.anns.values()].flat().map(a => a.type) : null'); } catch (e) {}
  }
  check('继续编辑恢复标注（浏览器版）', !!rec && rec.includes('rect') && rec.includes('underline'), JSON.stringify(rec));

  // 截图（人工目视审查用：shot-*.png，已 gitignore）
  const shot = async name => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(__dirname, 'shot-' + name + '.png'), Buffer.from(r.data, 'base64'));
  };
  await cdp.eval('closeMenu()');
  await shot('view');
  await cdp.mouse('mousePressed', dr.x + 35, dr.y + 22, 'right');
  await cdp.mouse('mouseReleased', dr.x + 35, dr.y + 22, 'right');
  await sleep(300);
  await shot('annmenu');

  // 独立验证只有尾页删除的会话，不让已有标注掩盖页数判断错误。
  const deletedTail = await cdp.eval(`(async () => {
    closeMenu();
    S.anns.clear(); S.history = []; S.redo = [];
    const confirmOriginal = window.confirm;
    window.confirm = () => true;
    try { await deletePageAt(S.pageOrder.length - 1); }
    finally { window.confirm = confirmOriginal; }
    await saveSession();
    const session = await idbOp('readonly', S.sessionKey);
    return { pages: S.pageOrder.length, savedPages: session?.pageOrder.length, sourcePages: session?.sourcePages, dirty };
  })()`);
  check('仅删除尾页也保存恢复记录', deletedTail.pages === 19 && deletedTail.savedPages === 19 && deletedTail.sourcePages === 20 && deletedTail.dirty, JSON.stringify(deletedTail));

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
} catch (err) {
  console.error('E2E 运行失败：', err.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
