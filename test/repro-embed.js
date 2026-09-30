// 忠实复现 app.js 导出路径：copyPages + 再嵌入 pdf.js 提取的字体 + drawAnn per-run 绘制，
// 然后用 pdf.js 回读渲染结果，对比每个 run 的实际绘制位置（暴露 subset 重映射造成的度量破坏）
const PDFLib = require('../vendor/pdf-lib.min.js');
const fontkit = require('../vendor/fontkit.min.js');
const pdfjs = require('../vendor/pdf.min.js');
const fs = require('fs');

const SRC = 'test/sample-embedded.pdf';
// pdf.js 规范化后的 LiberationSerif 子集（应用运行时 commonObjs 路径 dump，与导出时复用原字体的数据同源）
const FONT_DATA = new Uint8Array(Buffer.from(fs.readFileSync('test/embfont-serif-subset.b64', 'utf8').trim(), 'base64'));

// line-4 的 ann（与浏览器中一致：35 run，仅 font→fond）
const xs = [[50,'Embedded'],[101,' '],[106,'font'],[126,' '],[131,'reuse'],[156,' '],[161,'test'],[178,' '],[183,'for'],[197,' '],[202,'native'],[231,' '],[236,'looking'],[273,' '],[278,'text'],[296,' '],[301,'editing'],[334,' '],[339,'with'],[360,' '],[365,'Times'],[395,' '],[400,'New'],[423,' '],[428,'Roman'],[463,' '],[468,'glyphs'],[500,' '],[505,'and'],[522,' '],[527,'per'],[542,' '],[547,'word'],[572,' '],[577,'positioning']];
const runs = xs.map(([x, str]) => ({ x, baselineY: 688, size: 12, str, cur: str === 'font' ? 'fond' : str }));

async function buildExport(subset) {
  const src = await PDFLib.PDFDocument.load(fs.readFileSync(SRC));
  const out = await PDFLib.PDFDocument.create();
  out.registerFontkit(fontkit);
  const copied = await out.copyPages(src, [0]);
  const font = subset
    ? await out.embedFont(FONT_DATA, { subset: true })
    : await out.embedFont(FONT_DATA);
  const page = copied[0];
  out.addPage(page);
  // 涂白（与 app 相同：line box 外扩）
  page.drawRectangle({ x: 49.9, y: 687, width: 549, height: 15, color: PDFLib.rgb(1, 1, 1) });
  for (const r of runs) {
    if (!r.cur.trim()) continue;
    page.drawText(r.cur, { x: r.x, y: r.baselineY, size: r.size, font, color: PDFLib.rgb(0.1, 0.1, 0.1) });
  }
  return out.save();
}

async function itemsOf(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  return tc.items.filter(it => it.str.trim() && it.transform[5] > 680 && it.transform[5] < 700)
    .map(it => ({ str: it.str, x: +it.transform[4].toFixed(1), w: +it.width.toFixed(1) }));
}

(async () => {
  const expected = runs.filter(r => r.cur.trim()).map(r => `${r.str === 'font' ? 'fond' : r.str}@x=${r.x}`);

  for (const subset of [true, false]) {
    const bytes = await buildExport(subset);
    fs.writeFileSync(subset ? 'test/exported-subset.pdf' : 'test/exported-full.pdf', bytes);
    const items = await itemsOf(bytes);
    console.log(`\n=== subset:${subset} 导出后回读的第4行文字项 ===`);
    for (const it of items) console.log(`  "${it.str}" x=${it.x} w=${it.w}`);
    // 位置偏差
    let bad = 0;
    for (const e of expected) {
      const [word, x] = [e.slice(0, e.lastIndexOf('@x=')), +e.slice(e.lastIndexOf('@x=') + 3)];
      // 词尾超出提取边界时回读会截断（positioning→posi）：截断词也算命中，这里校验的是位置不是提取完整性
      const hit = items.find(it => it.str.startsWith(word) || word.startsWith(it.str));
      if (!hit || Math.abs(hit.x - x) > 2) { console.log(`  偏差! 期望 ${word}@x=${x}，实际 ${hit ? hit.str + '@x=' + hit.x : '缺失'}`); bad++; }
    }
    console.log(bad === 0 ? '  ✓ 全部位置正确' : `  ✗ ${bad} 处位置错误`);
  }
})().catch(e => { console.error(e); process.exit(1); });
