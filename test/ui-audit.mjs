// UI 布局/对比度审计（CDP，桌面版）：工具栏换行、winControls 位置、命中区、关键对比度
// 用法：带 --remote-debugging-port=9222 启动 pdfpro.exe，然后 node test/ui-audit.mjs
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import assert from 'node:assert/strict';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const wsUrl = (await (await fetch(BASE + '/json')).json())
  .find(t => t.type === 'page' && /index\.html/.test(t.url))?.webSocketDebuggerUrl;
if (!wsUrl) throw new Error('app page not found');

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let seq = 0;
const pend = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise(r => { const i = ++seq; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalp = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

const dataPath = await evalp('window.__TAURI__.path.appLocalDataDir()');
assert(dataPath.replace(/\\/g, '/').toLowerCase().startsWith(ROOT.toLowerCase() + '/src-tauri/target/'),
  '请使用 test/tauri-e2e.json 构建隔离实例，避免修改日常偏好');
await evalp(`setReading(false); setSimple(true); updateToolbarPreferences(['search', 'export']);
  if (!document.getElementById('sidebar').classList.contains('collapsed')) toggleSidebar();
  openPath('${ROOT}/test/sample.pdf')`);
await sleep(2500);

const report = async label => {
  const r = await evalp(`(() => {
    const tb = document.getElementById('toolbar');
    const groups = [...tb.querySelectorAll(':scope > .tb-group')].filter(c => c.getBoundingClientRect().width > 0);
    const rows = [...new Set(groups.map(c => {
      const rect = c.getBoundingClientRect();
      return Math.round(rect.top + rect.height / 2);
    }))];
    const wc = document.getElementById('winControls').getBoundingClientRect();
    const overflow = groups.filter(c => c.getBoundingClientRect().right > wc.left + 2);
    return { label: ${JSON.stringify(label)}, tbWidth: tb.clientWidth, rows: rows.length,
      wc: { top: Math.round(wc.top), right: Math.round(wc.right), left: Math.round(wc.left) },
      winW: innerWidth, underControls: overflow.map(c => c.id || c.className) };
  })()`);
  console.log(JSON.stringify(r));
  assert.equal(r.underControls.length, 0, label + ' 的工具不能盖住窗口按钮');
  return r;
};

console.log('--- 工具栏布局 ---');
const at1280 = await report('1280（默认窗口）');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 820, deviceScaleFactor: 0, mobile: false });
await sleep(400);
const at900 = await report('900（最小宽度）');
await send('Emulation.clearDeviceMetricsOverride');
await sleep(300);

console.log('--- 命中区与搜索侧栏 ---');
await evalp(`focusSearch(); document.getElementById('searchBox').value = 'fox'; doSearch('fox')`);
const hits = await evalp(`(() => {
  const t = s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null; };
  const panel = document.getElementById('searchHead');
  const pr = panel.getBoundingClientRect();
  const wcr = document.getElementById('winControls').getBoundingClientRect();
  return { winBtns: t('#winMin'), 工具栏按钮: t('#btnOpen'), zoomMenu: t('#btnZoomMenu'),
    搜索侧栏: { visible: !document.getElementById('sidebar').classList.contains('collapsed') && !panel.hidden,
      top: Math.round(pr.top), bottom: Math.round(pr.bottom), 与winControls重叠: pr.right > wcr.left && pr.top < wcr.bottom } };
})()`);
console.log(JSON.stringify(hits));
assert(hits.搜索侧栏.visible && !hits.搜索侧栏.与winControls重叠, '搜索结果必须可见且避开窗口按钮');

console.log('--- 对比度（WCAG，正文需 4.5:1，大字/图形 3:1）---');
const contrast = await evalp(`(() => {
  const lum = (r, g, b) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
    return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const cs = (fg, bg) => { const a = hex => { const n = parseInt(hex.slice(1), 16); return [lum((n >> 16) & 255, (n >> 8) & 255, n & 255)]; };
    const l1 = a(fg)[0], l2 = a(bg)[0]; return Math.round(((Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05)) * 100) / 100; };
  const out = {};
  for (const theme of ['dark', 'light']) {
    document.documentElement.dataset.theme = theme;
    const v = getComputedStyle(document.documentElement);
    const c = p => v.getPropertyValue(p).trim();
    out[theme] = {
      '工具栏图标(muted/bar)': cs(c('--muted'), c('--bar')),
      '正文(txt/bg)': cs(c('--txt'), c('--bg')),
      '按钮文字(txt/btn)': cs(c('--txt'), c('--btn')),
      '关闭hover(白/e5604c)': cs('#ffffff', '#e5604c'),
      'accent文字(accent-bright/bar)': cs(c('--accent-bright'), c('--bar')),
    };
  }
  document.documentElement.dataset.theme = 'dark';
  return out;
})()`);
console.log(JSON.stringify(contrast, null, 1));

console.log('--- 侧栏/缩略图/页面 ---');
const misc = await evalp(`(() => {
  const side = document.getElementById('sidebar');
  const th = document.querySelector('#tab-thumbs .thumb');
  const page = document.querySelector('.page');
  return { 侧栏宽: Math.round(side.getBoundingClientRect().width),
    缩略图宽: th ? Math.round(th.getBoundingClientRect().width) : null,
    页面水平居中偏差: page ? Math.round((page.getBoundingClientRect().left + page.getBoundingClientRect().right) / 2 - innerWidth / 2) : null };
})()`);
console.log(JSON.stringify(misc));

ws.close();
process.exit(0);
