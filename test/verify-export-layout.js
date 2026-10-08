// 用真实编辑提交与导出函数验证 run 变长、换行和缺字回退；仅 DOM/画布接口使用桩。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PDFLib = require('../vendor/pdf-lib.min.js');
const fontkit = require('../vendor/fontkit.min.js');
const { FONT_MAP, alignRunsByDiff, wrapLine, runFaceCss } = require('../app/textedit.js');

const ROOT = path.resolve(__dirname, '..');
const serif = fontkit.create(fs.readFileSync(path.join(ROOT, 'vendor/fonts/LiberationSerif-Regular.ttf')));
function widthOf(text, size) {
  return serif.layout(text).glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) / serif.unitsPerEm * size;
}

// sample-embedded.pdf 第四行的真实 run 位置，包括 pdf.js 插入的空格 run。
const xs = [[50,'Embedded'],[101,' '],[106,'font'],[126,' '],[131,'reuse'],[156,' '],
  [161,'test'],[178,' '],[183,'for'],[197,' '],[202,'native'],[231,' '],[236,'looking'],
  [273,' '],[278,'text'],[296,' '],[301,'editing'],[334,' '],[339,'with'],[360,' '],
  [365,'Times'],[395,' '],[400,'New'],[423,' '],[428,'Roman'],[463,' '],[468,'glyphs'],
  [500,' '],[505,'and'],[522,' '],[527,'per'],[542,' '],[547,'word'],[572,' '],[577,'positioning']];
const origText = xs.map(([, text]) => text).join('');

let currentAnn;
const listeners = new Map();
const element = {
  innerText: '', isContentEditable: true, classList: { add() {}, remove() {} }, focus() {},
  addEventListener(type, callback) { listeners.set(type, callback); },
  removeEventListener(type) { listeners.delete(type); },
};
const context = {
  PDFLib, FONT_MAP, alignRunsByDiff, wrapLine, runFaceCss,
  $: () => ({ addEventListener() {} }),
  S: { views: new Map([[0, {}]]), scale: 1 },
  pageEls: [{ querySelector: () => element }],
  annSlotOf: () => 0, annOf: () => currentAnn,
  renderAnnotations() {}, pushHistory() {}, removeAnn() { currentAnn = null; },
  window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
  document: { createRange: () => ({ selectNodeContents() {}, collapse() {} }) },
  embeddedFaceCache: new Map(),
  measureCtx: { measureText: text => ({ width: widthOf(text, 12) }) },
};
// app.js 的顶层装配需要完整浏览器；只加载这两个真实函数，不能复刻提交规则。
const source = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
vm.runInNewContext(
  source.slice(source.indexOf('function layoutWrapped('), source.indexOf('\nasync function startLineEdit(')) + '\n' +
  source.slice(source.indexOf('function startEditing('), source.indexOf('\n// 删除标注')),
  context,
);
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app/export.js'), 'utf8'), context);

const systemFont = {};
const fontObjs = new Map([['LiberationSerif-Regular.ttf', systemFont]]);
function drawnText(ann, embeddedFonts = new Map(), embeddedFk = new Map()) {
  const drawn = [];
  context.drawAnn({ drawRectangle() {}, drawText(text, options) { drawn.push({ text, ...options }); } },
    ann, fontObjs, {}, embeddedFonts, embeddedFk);
  return drawn;
}

function checkEdit(text, wrapped) {
  currentAnn = {
    id: 'edit', type: 'edit', page: 0, origText, text: origText,
    x1: 50, x2: 600, rects: [[50, 687, 600, 702]], fontKey: { family: 'serif' },
    runs: xs.map(([x, str]) => ({ x, baselineY: 688, size: 12, str, cur: str })),
  };
  element.innerText = text;
  context.startEditing('edit');
  assert.strictEqual(typeof listeners.get('blur'), 'function', '真实编辑入口应注册提交回调');
  listeners.get('blur')();
  assert(currentAnn, '修改后的标注应保留');
  assert.strictEqual(!!currentAnn.wrapped, wrapped);
  assert.strictEqual(currentAnn.runs.map(run => run.cur).join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  const drawn = drawnText(currentAnn);
  const rowEnds = new Map();
  for (const run of drawn) {
    if (!run.text.trim()) continue;
    const previousEnd = rowEnds.get(run.y);
    assert(previousEnd == null || run.x >= previousEnd - 0.5, `文字重叠：${run.text}`);
    const end = run.x + widthOf(run.text, run.size);
    rowEnds.set(run.y, end);
    if (wrapped) assert(end <= currentAnn.x2 + 0.5, `折行超出原行宽：${run.text}`);
  }
  if (wrapped) {
    assert.strictEqual(currentAnn.text, currentAnn.runs.map(run => run.cur).join('\n'));
    currentAnn.runs.forEach((run, index) => {
      assert.strictEqual(run.x, 50);
      assert.strictEqual(run.baselineY, 688 - index * 12 * 1.25);
    });
  } else {
    assert.strictEqual(currentAnn.runs.length, xs.length, '等长修改应保留原始 run');
  }
  return currentAnn;
}

const longer = checkEdit(origText.replace('reuse', 'reusable'), true);
assert(longer.runs.length > 1, '变长后应按原行宽折行');
checkEdit(origText.replace('font', 'fond'), false);
checkEdit(origText.replace('reuse ', 'reuse\n'), true);
const deleted = checkEdit('', true);
assert.strictEqual(drawnText(deleted).length, 0, '清空文字仅涂白，不应绘制文字');

const subset = fontkit.create(new Uint8Array(Buffer.from(
  fs.readFileSync(path.join(ROOT, 'test/embfont-serif-subset.b64'), 'utf8').trim(), 'base64')));
const originalFont = {};
for (const [text, expectedFont] of [['Times', originalFont], ['TimesQ', systemFont]]) {
  const ann = {
    type: 'edit', page: 0, text, fontKey: { family: 'serif' }, rects: [[50, 687, 600, 702]],
    runs: [{ x: 50, baselineY: 688, size: 12, fontName: 'embedded', cur: text }],
  };
  const drawn = drawnText(ann, new Map([['0:embedded', originalFont]]), new Map([['0:embedded', subset]]));
  assert.strictEqual(drawn.length, 1);
  assert.strictEqual(drawn[0].font, expectedFont, text + ' 的整 run 字体选择');
}
console.log('✓ 真实编辑提交、导出布局与子集缺字回退通过');
