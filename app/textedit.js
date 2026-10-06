'use strict';

// 改字排版:纯逻辑算法(run 拼接 / 字符级 diff 分配 / 折行 / 行线几何 / 字体选择)。
// 浏览器 <script> 顺序加载共享全局;顶层无 DOM 语句,test/ 可直接 require 本文件。

// 下划线 / 删除线的画线位置与线宽（预览与导出共用同一公式，所见即所得）
const markLine = (type, r) => ({
  y: type === 'underline' ? r[1] + (r[3] - r[1]) * 0.18 : (r[1] + r[3]) / 2,
  th: Math.max(1, (r[3] - r[1]) * 0.08),
});

// 把 run 列表拼成可编辑文本（位置空隙 → 空格字符）
function joinRuns(runs) {
  let out = '';
  for (const r of runs) {
    if (r.gapBefore && out && !/\s$/.test(out) && !/^\s/.test(r.cur)) out += ' ';
    out += r.cur;
  }
  return out;
}

// 提交后：把新文本按字符级 diff（LCS）分配回各 run，
// 改动落在原来的 run 里，未改动的 run 原地保留（位置/字体不变）
function alignRunsByDiff(ann, newText) {
  const runs = ann.runs;
  if (runs.length === 1) { runs[0].cur = newText; return true; }
  const orig = ann.origText;
  const n = orig.length, m2 = newText.length;
  if (!n || !m2 || n * m2 > 4000000) return false;
  // 字符 → run 归属（run 间空隙字符归前一个 run，避免前导空格推移文字）
  const owner = [];
  runs.forEach((r, i) => {
    if (i > 0 && r.gapBefore) owner.push(i - 1);
    for (let k = 0; k < r.str.length; k++) owner.push(i);
  });
  const W = m2 + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m2 - 1; j >= 0; j--) {
      dp[i * W + j] = orig[i] === newText[j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const cur = runs.map(() => '');
  let i = 0, j = 0;
  while (i < n && j < m2) {
    if (orig[i] === newText[j]) { cur[owner[i]] += newText[j]; i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { i++; }
    else { cur[owner[Math.max(0, i - 1)]] += newText[j]; j++; }
  }
  while (j < m2) { cur[runs.length - 1] += newText[j++]; }
  runs.forEach((r, idx) => { r.cur = cur[idx]; });
  return true;
}

// 贪心折行：优先断在词间空格（西文），行内无空格可断（中文/超长词）时逐字符断；
// fit(t) 判 t 是否还放得下当前行；断行处吃掉的空格不带入下一行
function wrapLine(text, fit) {
  const out = [];
  let cur = '';
  for (const ch of text) {
    if (cur && !fit(cur + ch)) {
      if (ch === ' ') { out.push(cur); cur = ''; continue; }
      const sp = cur.lastIndexOf(' ');
      if (sp > 0) { out.push(cur.slice(0, sp)); cur = cur.slice(sp + 1) + ch; }
      else { out.push(cur); cur = ch; }
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// 预览字体选择与导出同规则：run 文本任一字符不在嵌入子集 → 整个 run 用回退字体
//（导出侧是 hasCharacter 全或无；预览若走浏览器逐字回退，提交后字形会跳变）
// 回退字体也和导出 fontFileFor 一致：含非 ASCII → Noto Sans SC（@font-face 加载
// 与导出相同的字体文件，两边字形完全一致；SimHei 是 webfont 加载完成前的过渡），
// 否则按 pdf.js 归类映射的系统字体
function runFaceCss(face, fontKey, text, sizePx) {
  const fm = FONT_MAP[fontKey?.family] || FONT_MAP['sans-serif'];
  if (face) {
    try { if (document.fonts.check(sizePx + "px '" + face + "'", text || '')) return { css: `'${face}', '${fm.css}'`, hasFace: true }; } catch (e) {}
  }
  const cjk = /[^\x00-\x7F]/.test(text || '');
  return { css: cjk ? `'Noto Sans SC', 'SimHei', '${fm.css}'` : `'${fm.css}'`, hasFace: false, cjk };
}

// 系统字体映射：PDF.js 把原字体归类为 serif/sans-serif/monospace（含粗细）。
// 预览用系统字体名（css）；导出嵌入度量兼容的开源 Liberation 字体（file）——
// Liberation 与 Arial/Times/Courier 度量逐字符一致，导出布局与预览相同，且可合法再分发
const FONT_MAP = {
  'sans-serif': { css: 'Arial', file: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf', italic: 'LiberationSans-Italic.ttf', bolditalic: 'LiberationSans-BoldItalic.ttf' },
  'serif': { css: 'Times New Roman', file: 'LiberationSerif-Regular.ttf', bold: 'LiberationSerif-Bold.ttf', italic: 'LiberationSerif-Italic.ttf', bolditalic: 'LiberationSerif-BoldItalic.ttf' },
  'monospace': { css: 'Courier New', file: 'LiberationMono-Regular.ttf', bold: 'LiberationMono-Bold.ttf', italic: 'LiberationMono-Italic.ttf', bolditalic: 'LiberationMono-BoldItalic.ttf' },
};
// 检测行字体样式：family 来自 pdf.js 归类；粗体用宽度匹配（原字体宽度更接近
// 映射字体的 bold 还是 normal 渲染宽度），pdf.js 对粗体面也标 weight 400，只能这样判
async function detectFontStyle(slot, spanEl) {
  const cs = getComputedStyle(spanEl);
  const fam = (cs.fontFamily || '').toLowerCase();
  const family = fam.includes('monospace') ? 'monospace'
    : (fam.includes('serif') && !fam.includes('sans-serif')) ? 'serif' : 'sans-serif';
  const italic = cs.fontStyle === 'italic';
  let bold = false;
  try {
    const text = spanEl.textContent;
    const px = parseFloat(cs.fontSize) || 12;
    const m = FONT_MAP[family];
    const off = document.createElement('canvas');
    const octx = off.getContext('2d');
    octx.font = `${px}px "${m.css}"`;
    const w400 = octx.measureText(text).width;
    octx.font = `bold ${px}px "${m.css}"`;
    const w700 = octx.measureText(text).width;
    const actual = spanEl.getBoundingClientRect().width;
    if (w700 > w400 * 1.02) bold = Math.abs(actual - w700) < Math.abs(actual - w400);
  } catch (e) {}
  return { family, bold, italic };
}

// 浏览器无 module;Node 侧 test/ 直接 require
if (typeof module !== 'undefined') module.exports = { FONT_MAP, markLine, joinRuns, alignRunsByDiff, wrapLine, runFaceCss, detectFontStyle };
