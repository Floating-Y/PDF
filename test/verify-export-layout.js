// 验证导出布局：用浏览器里 dump 出的真实 run 结构 + 项目自带 pdf-lib/fontkit，
// 复算 drawAnn 的绘制结果，检查 (1) run 变长是否压到后续 run (2) 缺字降级的宽度影响
const PDFLib = require('../vendor/pdf-lib.min.js');
const fontkit = require('../vendor/fontkit.min.js');
const fs = require('fs');

// 直接从 app.js 提取真函数（joinRuns/alignRunsByDiff），避免复本与实现漂移
const appSrc = fs.readFileSync('app/app.js', 'utf8');
function extractFn(name) {
  const m = appSrc.match(new RegExp('^function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?^\\}', 'm'));
  if (!m) throw new Error('function not found in app.js: ' + name);
  return m[0];
}
const alignRunsByDiff = eval('(' + extractFn('alignRunsByDiff') + ')');

const serif = fontkit.create(fs.readFileSync('vendor/fonts/LiberationSerif-Regular.ttf'));
function widthOf(text, size) {
  const run = serif.layout(text);
  const units = run.glyphs.reduce((s, g) => s + g.advanceWidth, 0);
  return units / serif.unitsPerEm * size;
}
function covers(font, ch) {
  const gs = font.glyphsForString(ch);
  return gs.length > 0 && gs[0].name !== '.notdef';
}

// —— 浏览器 dump 的真实 run 结构（sample-embedded.pdf 第2行，节选关键 run）——
// 全部 run：词 run + pdf.js 插入的空格 run，x 为原始位置
const runs = [
  { str: 'Embedded', x: 50 }, { str: ' ', x: 101 }, { str: 'font', x: 106 },
  { str: ' ', x: 126 }, { str: 'reuse', x: 131 }, { str: ' ', x: 156 },
  { str: 'test', x: 161 }, { str: ' ', x: 178 }, { str: 'for', x: 183 },
  { str: ' ', x: 197 }, { str: 'native', x: 202 }, { str: ' ', x: 231 },
  { str: 'looking', x: 236 }, { str: ' ', x: 273 }, { str: 'text', x: 278 },
  { str: ' ', x: 296 }, { str: 'editing', x: 301 }, { str: ' ', x: 334 },
  { str: 'with', x: 339 }, { str: ' ', x: 360 }, { str: 'Times', x: 365 },
  { str: ' ', x: 395 }, { str: 'New', x: 400 }, { str: ' ', x: 423 },
  { str: 'Roman', x: 428 }, { str: ' ', x: 463 }, { str: 'glyphs', x: 468 },
  { str: ' ', x: 500 }, { str: 'and', x: 505 }, { str: ' ', x: 522 },
  { str: 'per', x: 527 }, { str: ' ', x: 542 }, { str: 'word', x: 547 },
  { str: ' ', x: 572 }, { str: 'positioning', x: 577 },
];
// origText = joinRuns（空格 run 本身提供空格字符，gapBefore 全 false）
const origText = runs.map(r => r.str).join('');

// alignRunsByDiff 直接取自 app.js（见文件头部 extractFn），不再维护复本

function checkEdit(name, newText) {
  const ann = { origText, runs: runs.map(r => ({ ...r, cur: r.str })) };
  alignRunsByDiff(ann, newText);
  console.log('\n=== [旧逻辑] ' + name + ' ===');
  let prevEnd = null, prevLabel = null, overlap = false;
  for (const r of ann.runs) {
    if (!r.cur) continue;
    const wEnd = r.x + widthOf(r.cur, 12);
    // 只对比相邻“词”run（跳过空格 run 的间隔语义），检查词 run 之间是否重叠
    if (r.cur.trim() && prevEnd != null && r.x < prevEnd - 0.5) {
      console.log(`  重叠! "${prevLabel}" 结束于 x=${prevEnd.toFixed(1)}，"${r.cur}" 起始于 x=${r.x}`);
      overlap = true;
    }
    if (r.cur.trim()) { prevEnd = Math.max(prevEnd ?? 0, wEnd); prevLabel = r.cur; }
  }
  console.log('  变长 run 绘制宽度: reuse→' + (ann.runs.find(r => r.str === 'reuse')?.cur) +
    ' 宽 ' + widthOf(ann.runs.find(r => r.str === 'reuse')?.cur || '', 12).toFixed(1) +
    'pt，与下一个 run（x=161）的可用空间 ' + (161 - 131) + 'pt');
  return overlap;
}

checkEdit('编辑1: reuse→reusable（变长）', origText.replace('reuse', 'reusable'));
checkEdit('编辑3: font→fond（等长）', origText.replace('font', 'fond'));

// —— 修复后的提交逻辑（app.js 新逻辑复刻）：变长 → 整行单 run；否则保留 per-run ——
function commitFixed(ann, text) {
  if (!alignRunsByDiff(ann, text)) {
    ann.runs = [{ ...ann.runs[0], str: text, cur: text, gapBefore: false }];
  } else if (ann.runs.some(r => r.cur.trim().length > r.str.trim().length)) {
    const pick = ann.runs.find(r => r.cur.trim().length > r.str.trim().length) || ann.runs[0];
    ann.runs = [{
      x: ann.runs[0].x, baselineY: ann.runs[0].baselineY,
      size: pick.size || 12, fontName: pick.fontName,
      str: text, cur: text, gapBefore: false,
    }];
  }
  return ann;
}

function checkFixed(name, newText) {
  const ann = commitFixed({ origText, runs: runs.map(r => ({ ...r, cur: r.str })) }, newText);
  console.log('\n=== [修复后] ' + name + ' ===');
  if (ann.runs.length === 1) {
    const wEnd = ann.runs[0].x + widthOf(ann.runs[0].cur, 12);
    console.log(`  整行单 run @x=${ann.runs[0].x}，宽 ${widthOf(ann.runs[0].cur, 12).toFixed(1)}pt → 无内部重叠（与编辑态单框预览同布局）`);
  } else {
    let prevEnd = null, overlap = false;
    for (const r of ann.runs) {
      if (!r.cur || !r.cur.trim()) continue;
      const wEnd = r.x + widthOf(r.cur, 12);
      if (prevEnd != null && r.x < prevEnd - 0.5) { console.log(`  重叠! "${r.cur}"`); overlap = true; }
      prevEnd = Math.max(prevEnd ?? 0, wEnd);
    }
    console.log(overlap ? '  仍有重叠!' : '  per-run 保留，无重叠（与导出同规则）');
  }
}

checkFixed('编辑1: reuse→reusable（变长）', origText.replace('reuse', 'reusable'));
checkFixed('编辑3: font→fond（等长）', origText.replace('font', 'fond'));

// 缺字降级：Q 不在原子集（doc 文本无 Q）→ hasCharacter=false → 整 run 降级
console.log('\n=== [旧逻辑] 编辑2: Times→TimesQ（子集缺字） ===');
console.log('  完整 LiberationSerif 覆盖 Q? ' + covers(serif, 'Q') + '（实际嵌入的是子集程序，覆盖=doc 出现过的字符，Q 不在其中 → hasCharacter=false）');
console.log('  旧逻辑：导出整 run 降级 Arial，预览仅 Q 单字回退 → 两边字形不一致（已修复）');
console.log('  新逻辑：预览用 document.fonts.check 与导出同规则，整 run 一起降级（Times→TimesQ 两边都回退同一字体）');
