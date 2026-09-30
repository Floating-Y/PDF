// 生成内嵌字体的测试 PDF（模拟 LaTeX：逐词定位绘制，空格是位置间隙而非字符）
// 用法：node tools/gen-test-pdf-embedded.js
const PDFLib = require('../vendor/pdf-lib.min.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

(async () => {
  const doc = await PDFLib.PDFDocument.create();
  const fontkit = require('../vendor/fontkit.min.js');
  doc.registerFontkit(fontkit);
  const times = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'vendor/fonts/LiberationSerif-Regular.ttf')), { subset: true });
  const timesB = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'vendor/fonts/LiberationSerif-Bold.ttf')), { subset: true });
  const words = 'Embedded font reuse test for native looking text editing with Times New Roman glyphs and per word positioning like LaTeX does. ';
  for (let i = 1; i <= 10; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Page ${i} of 10`, { x: 50, y: 800, size: 20, font: timesB });
    let y = 760;
    for (let line = 0; line < 28; line++) {
      // 逐词绘制，词间 5pt 位置间隙（无空格字符）——模拟 LaTeX 的定位式排版
      let x = 50;
      for (const w of words.split(' ')) {
        if (!w) continue;
        page.drawText(w, { x, y, size: 12, font: times });
        x += times.widthOfTextAtSize(w, 12) + 5;
      }
      y -= 24;
    }
  }
  fs.writeFileSync(path.join(ROOT, 'test', 'sample-embedded.pdf'), await doc.save());
  console.log('test/sample-embedded.pdf written (per-word positioned, embedded LiberationSerif subset)');
})();
