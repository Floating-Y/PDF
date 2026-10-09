// 执行真实保存/恢复函数；只替换 IndexedDB、对话框和 DOM，不复刻业务判断。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const { File } = require('buffer');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app/app.js'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'app/storage.js'), 'utf8');
const elements = new Map();
function element(selector) {
  if (!elements.has(selector)) elements.set(selector, {
    hidden: true, disabled: false, textContent: '', children: [],
    classList: { toggle() {}, remove() {} }, addEventListener() {},
    appendChild(child) { this.children.push(child); },
  });
  return elements.get(selector);
}
const database = new Map();
const messages = [];
const sourceBytes = new Uint8Array([1, 2, 3]);
const state = {
  pdfDoc: { numPages: 3 }, srcBytes: sourceBytes, docName: 'report.pdf', docSize: 3,
  srcPath: 'D:/B/report.pdf', sessionKey: null, currentSlot: 0,
  pageOrder: [0, 1, 2].map(src => ({ src, rot: 0 })), anns: new Map(),
};
const context = vm.createContext({
  S: state, TAURI: true, annSeq: 1, crypto: webcrypto, Uint8Array, File, console: { error() {} },
  idbKeyval: { createStore: () => ({}) }, // 真实 IndexedDB 与 idb-keyval 不进 vm，下面的 idbOp/idbDel mock 顶上
  window: {}, document: { body: { inert: false }, activeElement: { blur() {} }, createElement: () => element('recent-button') },
  $: element, toast: message => messages.push(message), esc: text => text,
  setTimeout: () => 1, clearTimeout() {}, ensureEmbeddedFace: async () => null,
  buildViewer: async () => {}, writeBytesTauri: async () => {}, ti: async () => null,
});
const dirtyStart = app.indexOf('// ---------------- 未导出修改标记');
const dirtyEnd = app.indexOf("window.addEventListener('beforeunload'", dirtyStart);
assert(dirtyStart >= 0 && dirtyEnd > dirtyStart, '必须加载真实修改状态判断');
vm.runInContext(app.slice(dirtyStart, dirtyEnd), context);
vm.runInContext(storage.replace(/^renderRecents\(\);\r?$/gm, '').replace(/^renderRecover\(\);\r?$/gm, ''), context);
vm.runInContext(fs.readFileSync(path.join(root, 'app/export.js'), 'utf8'), context);
context.idbOp = async (mode, key, value) => {
  if (mode === 'readonly') return database.get(key);
  database.set(key, value);
  return key;
};
context.idbDel = async key => { database.delete(key); };
context.buildExportBytes = async () => new Uint8Array([4, 5, 6]);
const evaluate = expression => vm.runInContext(expression, context);

(async () => {
  const keyA = await context.sessKey('report.pdf', sourceBytes, 'D:/A/report.pdf');
  const keyB = await context.sessKey('report.pdf', sourceBytes, state.srcPath);
  assert.notEqual(keyA, keyB, '桌面副本必须按路径隔离');
  assert.equal(keyB, await context.sessKey('report.pdf', sourceBytes, 'd:\\b\\REPORT.pdf'));
  assert.notEqual(await context.sessKey('report.pdf', sourceBytes),
    await context.sessKey('report.pdf', new Uint8Array([3, 2, 1])), '同名同大小不同内容必须隔离');
  state.sessionKey = keyB;

  state.pageOrder.pop();
  context.markDirty();
  assert.equal(evaluate('dirty'), true);
  assert.equal(await context.saveSession(), true);
  assert.equal(database.get(keyB).pageOrder.length, 2, '尾页删除必须留在会话中');
  state.pageOrder.push({ src: 2, rot: 0 });
  context.clearDirty();
  await context.maybeRestoreSession();
  assert.equal(state.pageOrder.length, 2, '尾页删除必须恢复');
  await context.applySession({ ...database.get(keyB), path: 'D:/A/report.pdf' });
  assert.equal(state.srcPath, 'D:/B/report.pdf', '恢复记录不能改写实际打开的保存目标');
  context.refreshDirty();
  assert.equal(evaluate('dirty'), true, '连续前缀不是完整原文档');

  assert.equal(await context.exportPdf(), false, '取消桌面保存不能当作成功');
  assert.equal(evaluate('dirty'), true);
  assert(database.has(keyB), '取消保存必须保留恢复会话');
  assert.equal(context.document.body.inert, false, '取消后必须恢复交互');
  context.writeBytesTauri = async () => { throw new Error('write failed'); };
  assert.equal(await context.saveInPlace(), false, '写回失败不能清除修改');
  assert.equal(evaluate('dirty'), true);
  assert(database.has(keyB));
  assert.equal(context.document.body.inert, false);
  context.writeBytesTauri = async () => {};
  context.TAURI = false;
  context.window.showSaveFilePicker = async () => { throw Object.assign(new Error('cancel'), { name: 'AbortError' }); };
  assert.equal(await context.exportPdf(), false, '取消浏览器保存不能当作成功');
  assert(database.has(keyB));
  context.window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => { throw new Error('disk full'); } }) });
  assert.equal(await context.exportPdf(), false, '磁盘写入失败不能当作下载成功');
  assert.equal(evaluate('dirty'), true);
  assert(database.has(keyB));

  // 导出成功会清除未保存提示，但之后打印仍须包含页面修改。
  context.TAURI = true;
  context.ti = async () => 'D:/exported.pdf';
  assert.equal(await context.exportPdf(), true);
  assert.equal(evaluate('dirty'), false);
  assert(!database.has(keyB));
  let printed;
  context.printBytes = bytes => { printed = bytes; };
  await context.printPdf();
  assert.deepEqual([...printed], [4, 5, 6], '导出后打印必须合成尾页删除');
  state.pageOrder = [0, 1, 2].map(src => ({ src, rot: 0 }));
  state.anns.set(0, [{ type: 'highlight', page: 0 }]);
  await context.printPdf();
  assert.deepEqual([...printed], [4, 5, 6], '导出后打印必须合成标注');
  state.anns.clear();
  await context.printPdf();
  assert.equal(printed, sourceBytes, '无修改仍使用原文件');

  state.pageOrder.pop();
  context.markDirty();
  context.idbOp = async () => null;
  assert.equal(await context.saveSession(), false);
  assert(messages.some(message => /自动保存.*失败/.test(message)), '自动保存失败应提示用户');
  context.loadRecents = async () => [{ name: 'report.pdf', size: 3, at: Date.now(), handle: { path: state.srcPath } }];
  await context.renderRecents();
  assert.equal(element('#recentBox').hidden, false, '桌面最近文件不依赖 showOpenFilePicker');
  assert.equal(element('#recentList').children.length, 1);

  // 保存开始前已进入打开流程的操作，异步读取完成后仍不能换掉保存目标。
  const openStart = app.indexOf('async function openFile(');
  const openEnd = app.indexOf('\nfunction enableToolbar(', openStart);
  assert(openStart >= 0 && openEnd > openStart);
  vm.runInContext(app.slice(openStart, openEnd), context);
  let unblock, reached;
  const gate = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const saveSession = context.saveSession;
  context.saveSession = async () => { reached(); await gate; };
  let destroyed = false;
  context.pdfjsLib = { getDocument: () => ({ promise: Promise.resolve({ numPages: 2, destroy: async () => { destroyed = true; } }) }) };
  const oldPath = state.srcPath;
  const opening = context.openFile({ name: 'new.pdf', type: 'application/pdf', size: 3,
    arrayBuffer: async () => sourceBytes.buffer }, { path: 'D:/new.pdf' });
  await entered;
  evaluate('savingPdf = true');
  unblock();
  assert.equal(await opening, false);
  assert.equal(state.srcPath, oldPath);
  assert.equal(destroyed, true, '被保存锁取消的新文档须释放');
  evaluate('savingPdf = false');
  context.saveSession = saveSession;

  const editStart = app.indexOf('async function selectionToEditText(');
  const editEnd = app.indexOf('\nfunction removeAnn(', editStart);
  assert(editStart >= 0 && editEnd > editStart);
  vm.runInContext(app.slice(editStart, editEnd), context);
  const span = { textContent: 'original' };
  context.selectionRectsBySlot = () => ({
    sel: { toString: () => 'original', anchorNode: { parentElement: { closest: () => span } } },
    bySlot: new Map([[0, { rects: [[0, 0, 50, 12]], crects: [{}] }]]),
  });
  let finishFont;
  context.detectFontStyle = () => new Promise(resolve => { finishFont = resolve; });
  const editing = context.selectionToEditText();
  evaluate('savingPdf = true');
  finishFont({ family: 'serif' });
  await editing;
  assert.equal(state.anns.size, 0, '待完成的改字操作不能在保存期间加入标注');
  evaluate('savingPdf = false');

  // 恢复按钮只在原文件内容仍匹配时保留写回路径；变化后恢复为独立副本。
  context.idbOp = async (mode, key, value) => {
    if (mode === 'readonly') return database.get(key);
    database.set(key, value);
    return key;
  };
  context.idbKeys = async () => [...database.keys()];
  const session = { name: state.docName, size: 3, at: Date.now(), path: 'D:/B/report.pdf',
    sourcePages: 3, pageOrder: [{ src: 0, rot: 0 }, { src: 1, rot: 0 }], anns: [], annSeq: 1 };
  database.clear();
  database.set(keyB, session);
  database.set('session-file', { name: state.docName, size: 3, bytes: sourceBytes, key: keyB });
  let copied = false;
  context.openPath = async actualPath => { state.srcPath = actualPath; state.sessionKey = keyB; return true; };
  context.openFile = async file => {
    copied = true;
    state.srcPath = null;
    state.sessionKey = await context.sessKey(file.name, new Uint8Array(await file.arrayBuffer()));
    return true;
  };
  await context.renderRecover();
  await element('#btnRecover').onclick();
  assert.equal(state.srcPath, 'D:/B/report.pdf');
  assert.equal(copied, false, '原件匹配时不应打开无路径副本');
  context.openPath = async actualPath => { state.srcPath = actualPath; state.sessionKey = 'changed-content'; return true; };
  await element('#btnRecover').onclick();
  assert.equal(copied, true);
  assert.equal(state.srcPath, null, '原件变化时不能把恢复的旧内容写回原件');
  assert.equal(state.pageOrder.length, 2);
  assert(!database.has(keyB), '成功迁移恢复副本后应删除旧会话');
  console.log('✓ 保存取消、失败、打印一致性及会话隔离/尾页恢复通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
