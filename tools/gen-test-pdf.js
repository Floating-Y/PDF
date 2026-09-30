// 生成测试 PDF：node tools/gen-test-pdf.js
const PDFLib = require('../vendor/pdf-lib.min.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

(async () => {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  const words = 'The quick brown fox jumps over the lazy dog. PDF annotation test paragraph with enough text to span multiple lines on each page for selection and highlight testing. ';
  for (let i = 1; i <= 20; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Page ${i} of 20`, { x: 50, y: 800, size: 20, font: bold });
    let y = 760;
    for (let line = 0; line < 30; line++) {
      const text = (words + words).slice(0, 110);
      page.drawText(text, { x: 50, y, size: 11, font });
      y -= 22;
    }
  }
  fs.writeFileSync(path.join(ROOT, 'test', 'sample.pdf'), await doc.save());
  console.log('test/sample.pdf written, 20 pages');
})();
