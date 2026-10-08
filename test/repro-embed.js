// 运行真实 buildExportBytes，再用 pdf.js 回读字体子集的文字、位置与宽度。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PDFLib = require('../vendor/pdf-lib.min.js');
const fontkit = require('../vendor/fontkit.min.js');
const pdfjs = require('../vendor/pdf.min.js');
const { FONT_MAP } = require('../app/textedit.js');
const ROOT = path.resolve(__dirname, '..');
const FONT_DATA = new Uint8Array(Buffer.from(
  fs.readFileSync(path.join(ROOT, 'test/embfont-serif-subset.b64'), 'utf8').trim(), 'base64'));
const serif = fontkit.create(FONT_DATA);
const xs = [[50,'Embedded'],[101,' '],[106,'font'],[126,' '],[131,'reuse'],[156,' '],
  [161,'test'],[178,' '],[183,'for'],[197,' '],[202,'native'],[231,' '],[236,'looking'],
  [273,' '],[278,'text'],[296,' '],[301,'editing'],[334,' '],[339,'with'],[360,' '],
  [365,'Times'],[395,' '],[400,'New'],[423,' '],[428,'Roman'],[463,' '],[468,'glyphs'],
  [500,' '],[505,'and'],[522,' '],[527,'per'],[542,' '],[547,'word'],[572,' '],[577,'positioning']];
const runs = xs.map(([x, str]) => ({
  x, baselineY: 688, size: 12, fontName: 'serif', str, cur: str === 'font' ? 'fond' : str,
}));

(async () => {
  // 空白源页避免涂白下的原文字误中断言；足够页宽也禁止用截断词冒充完整文字。
  const source = await PDFLib.PDFDocument.create();
  source.addPage([700, 792]);
  const state = {
    srcBytes: await source.save(), pageOrder: [{ src: 0, rot: 0 }],
    pdfDoc: { getPage: async () => ({ rotate: 0 }) },
    anns: new Map([[0, [{ type: 'edit', page: 0, text: runs.map(run => run.cur).join(''),
      fontKey: { family: 'serif' }, rects: [[49.9, 687, 680, 702]], runs }]]]),
  };
  const context = {
    PDFLib, fontkit, FONT_MAP, S: state, console, Uint8Array, ArrayBuffer,
    $: () => ({ addEventListener() {} }),
    getEmbeddedFontData: async () => FONT_DATA,
    toast(message) { throw new Error(message); },
    async fetch(url) {
      const bytes = fs.readFileSync(path.join(ROOT, url));
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app/export.js'), 'utf8'), context);
  const bytes = await context.buildExportBytes();
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  try {
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const items = content.items.filter(item => item.str.trim());
    const expected = runs.filter(run => run.cur.trim());
    assert.strictEqual(items.length, expected.length, '导出文字项不能缺失或混入原文');
    for (let index = 0; index < expected.length; index++) {
      const run = expected[index], item = items[index];
      assert.strictEqual(item.str, run.cur, '文字应完整且按顺序保留');
      assert(Math.abs(item.transform[4] - run.x) <= 0.2, `${run.cur} 的 x 位置错误`);
      assert(Math.abs(item.transform[5] - run.baselineY) <= 0.2, `${run.cur} 的基线错误`);
      const width = serif.layout(run.cur).glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0)
        / serif.unitsPerEm * run.size;
      assert(Math.abs(item.width - width) <= 0.5, `${run.cur} 的字体宽度错误`);
    }
    console.log('✓ 真实导出的字体子集文字、位置与宽度回读通过');
  } finally {
    await document.destroy();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
