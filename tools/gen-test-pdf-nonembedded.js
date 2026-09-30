// 生成"未内嵌字体"测试 PDF：node tools/gen-test-pdf-nonembedded.js
// 这类 PDF 依赖 pdf.js 的 cMapUrl / standardFontDataUrl 配置才能正确渲染，
// 用来回归验证 app.js 的 getDocument 参数（详见 README）。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function build(objs, streams) {
  let out = '%PDF-1.7\n';
  const offsets = [];
  for (let i = 1; i <= objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i - 1]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const descriptor = `<< /Type /FontDescriptor /FontName /SimSun /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>`;
const descendants = () => `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 /FontDescriptor 7 0 R >>`;
const type0 = (enc) => `<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /${enc} /DescendantFonts [6 0 R] >>`;
const page = (contentRef) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents ${contentRef} 0 R >>`;

// 1) UniGB-UCS2-H：码点即 Unicode（中文 = <4E2D6587>），双字节即 CID
const ucs2Stream = 'BT /F1 48 Tf 72 700 Td <4E2D6587> Tj ET\n';
fs.writeFileSync(path.join(ROOT, 'test', 'cmap-nonembedded.pdf'), build([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  page(5),
  type0('UniGB-UCS2-H'),
  `<< /Length ${ucs2Stream.length} >>\nstream\n${ucs2Stream}endstream`,
  descendants(),
  descriptor,
]));

// 2) GBK-EUC-H：内容码是 GBK 字节，必须经 CMap 映射到 Adobe-GB1 CID 才能得到正确字形
//    （中 = GBK D6D0 → CID 554；你好 = GBK C4E3BAC3）——这是判别 cMapUrl 是否生效的关键用例
const gbkStream = 'BT /F1 48 Tf 72 700 Td <D6D0> Tj ET\nBT /F1 24 Tf 72 620 Td <C4E3BAC3> Tj ET\n';
fs.writeFileSync(path.join(ROOT, 'test', 'gbk-nonembedded.pdf'), build([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  page(5),
  type0('GBK-EUC-H'),
  `<< /Length ${gbkStream.length} >>\nstream\n${gbkStream}endstream`,
  descendants(),
  descriptor,
]));

console.log('test/cmap-nonembedded.pdf、test/gbk-nonembedded.pdf written');
console.log('验证：浏览器打开后应显示"中文"/"中 你好"；若缺 cMaps 配置则字形残缺或空白');
