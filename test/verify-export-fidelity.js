// 导出保真：原地修改必须保留书签 / 表单 / 元数据，页序 / 删页 / 旋转与 pageOrder 一致。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PDFLib = require('../vendor/pdf-lib.min.js');
const fontkit = require('../vendor/fontkit.min.js');
const pdfjs = require('../vendor/pdf.min.js');
pdfjs.GlobalWorkerOptions.workerSrc = path.join(__dirname, '../vendor/pdf.worker.min.js');
const { FONT_MAP } = require('../app/textedit.js');

(async () => {
  const { PDFDocument, StandardFonts, PDFName, degrees } = PDFLib;
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 4; i++) {
    const p = src.addPage([500, 700]);
    p.drawText('Page' + i, { x: 50, y: 650, size: 20, font });
  }
  src.setTitle('fidelity-title');
  src.getForm().createTextField('fidelity.field');
  // 最小 /Outlines（指向第 0 页）：pdf-lib 没有书签 API，用低级对象挂到 catalog
  const ctx = src.context, outlinesRef = ctx.nextRef(), itemRef = ctx.nextRef();
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 }));
  ctx.assign(itemRef, ctx.obj({ Title: 'goto p0', Parent: outlinesRef,
    Dest: [src.getPage(0).ref, 'XYZ', null, null, null] }));
  src.catalog.set(PDFName.of('Outlines'), outlinesRef);

  const state = {
    srcBytes: await src.save(),
    // 重排为 [2,0,1] + 删第 3 页；首个槽位额外转 90°
    pageOrder: [{ src: 2, rot: 90 }, { src: 0, rot: 0 }, { src: 1, rot: 0 }],
    anns: new Map(),
    pdfDoc: { getPage: async () => ({ rotate: 0 }) }, // 旧依赖，原地管线不再读
  };
  const context = {
    PDFLib, fontkit, FONT_MAP, S: state, console, Uint8Array, ArrayBuffer,
    $: () => ({ addEventListener() {} }),
    getEmbeddedFontData: async () => null,
    toast(message) { throw new Error(message); },
    async fetch() { throw new Error('无标注不应取字体'); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/export.js'), 'utf8'), context);
  const bytes = await context.buildExportBytes();

  const out = await PDFLib.PDFDocument.load(bytes);
  assert.strictEqual(out.getPageCount(), 3, '删页生效');
  assert.strictEqual(out.getTitle(), 'fidelity-title', '文档元数据保留');
  assert.strictEqual(out.getForm().getFields().length, 1, '表单字段保留');
  assert(out.catalog.get(PDFName.of('Outlines')), '书签保留');
  assert.strictEqual(out.getPage(0).getRotation().angle, 90, '旋转生效');

  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  try {
    const texts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      texts.push(tc.items.map(it => it.str).join('').trim());
    }
    assert.deepStrictEqual(texts, ['Page2', 'Page0', 'Page1'], '页序重排生效');
  } finally {
    await doc.destroy();
  }
  console.log('✓ 导出保真：书签 / 表单 / 元数据保留，页序 / 删页 / 旋转生效');
})().catch(error => { console.error(error); process.exitCode = 1; });
