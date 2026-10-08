/* global PDFLib, fontkit */
'use strict';

// ---------------- 导出 ----------------
$('#btnSave').addEventListener('click', exportPdf);

function fontFileFor(a) {
  if (/[^\x00-\x7F]/.test(a.text || '')) return 'NotoSansSC-Regular.otf';
  const fk = a.fontKey || { family: 'sans-serif', bold: false, italic: false };
  const m = FONT_MAP[fk.family] || FONT_MAP['sans-serif'];
  return fk.bold && fk.italic ? m.bolditalic : fk.bold ? m.bold : fk.italic ? m.italic : m.file;
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

async function exportPdf() {
  if (!S.pdfDoc || savingPdf || $('#btnSave').disabled) return false;
  document.activeElement?.blur(); // 导出前提交仍在输入的标注
  setPdfSaving(true);
  const { docName, sessionKey } = S;
  toast('正在导出…（含字体嵌入，大文件可能需要几十秒）', 60000);
  try {
    const bytes = await buildExportBytes();
    if (!(await saveBytes(bytes, docName.replace(/\.pdf$/i, '') + '-edited.pdf'))) {
      toast('已取消导出');
      return false;
    }
    clearDirty();
    clearTimeout(sessionSaveTimer);
    await idbDel(sessionKey); // 已导出，恢复会话不再需要
    return true;
  } catch (err) {
    console.error(err);
    toast(exportErrMsg(err), 4000);
    return false;
  } finally { setPdfSaving(false); }
}

function setPdfSaving(value) {
  savingPdf = value;
  document.body.inert = value; // 合成及写回期间不允许再编辑，防止重载丢掉并发修改
  $('#btnSave').disabled = value;
}

function exportErrMsg(err) {
  const m = String(err?.message || err);
  if (/encrypt/i.test(m)) return '原文件已加密，导出暂不支持（请先用其他工具另存解密副本）';
  return '导出失败：' + m;
}

// 桌面版保存：写回原文件（首次覆盖前 Rust 侧自动备份 .bak）；无路径（浏览器打开）则退回另存为。
// 写回成功后必须从磁盘重建文档状态（pdfDoc/pageOrder/anns/docSize 全部对齐新文件）：
// 标注已烘焙为页面内容，重开后自然可见；不重建的话，后续保存会拿旧页索引索引新文档（崩溃）
// 或把已烘焙的标注再画一遍（重影）。撤销栈随重建清空 = 保存点。
async function saveInPlace() {
  if (!S.pdfDoc || savingPdf || $('#btnSave').disabled) return false;
  if (!S.srcPath) return await exportPdf();
  document.activeElement?.blur();
  setPdfSaving(true);
  const { srcPath: targetPath, sessionKey } = S;
  toast('正在保存…（合成修改，与导出相同）', 60000);
  try {
    const bytes = await buildExportBytes();
    await writeBytesTauri(targetPath, bytes);
    clearDirty();
    clearTimeout(sessionSaveTimer);
    await idbDel(sessionKey); // key 含旧文件摘要，重建前删掉
    if (await reloadAfterInPlaceWrite()) toast('已保存：' + S.docName);
    return true;
  } catch (err) {
    console.error(err);
    toast(exportErrMsg(err).replace('导出', '保存'), 4000);
    return false;
  } finally { setPdfSaving(false); }
}
const normPath = p => p.replace(/\//g, '\\').toLowerCase(); // Windows 路径比较：分隔符 + 大小写归一
async function reloadAfterInPlaceWrite() {
  const { scale, zoomMode, currentSlot } = S;
  if (!(await openPath(S.srcPath, true))) { toast('已保存，但重新读取文件失败，请手动重新打开'); return false; }
  if (S.pdfDoc) {
    // 先跳页再适配：fitWidth/fitPage 按当前页尺寸计算，顺序反了会用错页
    jumpToSlot(Math.min(currentSlot, S.pageOrder.length - 1));
    if (zoomMode === 'fitw') fitWidth();
    else if (zoomMode === 'fitp') fitPage();
    else if (Math.abs(scale - S.scale) > 1e-6) setScale(scale);
  }
  return true;
}

// 打印：无修改直接打印原文件；有修改先按导出管线合成（标注 / 删页 / 旋转全部生效）
async function printPdf() {
  if (!S.pdfDoc) return;
  try {
    if (hasDocumentChanges()) {
      toast('正在准备打印…（合成修改，与导出相同）', 60000);
      printBytes(await buildExportBytes());
    } else {
      printBytes(S.srcBytes);
    }
  } catch (err) {
    console.error(err);
    toast(exportErrMsg(err).replace('导出', '打印'), 4000);
  }
}
function printBytes(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const fr = document.createElement('iframe');
  // 不能 display:none：Chromium 对隐藏 iframe 里的 PDF 查看器不渲染，打印会出空白
  fr.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  fr.src = url;
  fr.onload = () => {
    try { fr.contentWindow.focus(); fr.contentWindow.print(); }
    catch (e) { console.error(e); toast('打印失败：' + e.message); }
    setTimeout(() => { fr.remove(); URL.revokeObjectURL(url); }, 60000); // 打印对话框关闭后再清理
  };
  document.body.appendChild(fr);
}

async function buildExportBytes() {
  const src = await PDFLib.PDFDocument.load(S.srcBytes);
  const out = await PDFLib.PDFDocument.create();
  const copied = await out.copyPages(src, S.pageOrder.map(s => s.src));

  const helv = await out.embedFont(PDFLib.StandardFonts.Helvetica);
  out.registerFontkit(fontkit);
  // 按标注映射收集需要的系统字体并逐个嵌入（失败降级 Helvetica）
  const needed = new Set();
  for (const list of S.anns.values()) for (const a of list) {
    if ((a.type === 'text' || a.type === 'edit') && a.text) needed.add(fontFileFor(a));
  }
  const fontObjs = new Map(); // file -> PDFFont
  for (const file of needed) {
    try {
      const bytes = await fetch('/vendor/fonts/' + file).then(r => { if (!r.ok) throw new Error(file); return r.arrayBuffer(); });
      fontObjs.set(file, await out.embedFont(new Uint8Array(bytes), { subset: true }));
    } catch (e) {
      console.error('font embed failed', file, e);
      toast(`字体 ${file} 嵌入失败，该标注将用替代字体`, 3000);
    }
  }
  // 复用 PDF 内嵌的原字体程序（按 页面:字体名 收集）：替换文字用原字形
  const embeddedFonts = new Map(); // "src:fontName" -> PDFFont
  const embeddedFk = new Map();    // "src:fontName" -> fontkit font（字形覆盖检查）
  for (const list of S.anns.values()) for (const a of list) {
    if (a.type !== 'edit' || !a.text) continue;
    const fns = new Set();
    if (a.runs) a.runs.forEach(r => { if (r.fontName && r.cur) fns.add(r.fontName); });
    else if (a.fontName) fns.add(a.fontName);
    for (const fn of fns) {
      const key = a.page + ':' + fn;
      if (embeddedFonts.has(key)) continue;
      const data = await getEmbeddedFontData(a.page, fn);
      if (!data) continue;
      try {
        embeddedFonts.set(key, await out.embedFont(data, { subset: true }));
        embeddedFk.set(key, fontkit.create(data));
      } catch (e) {
        console.error('embedded font re-embed failed', fn, e);
      }
    }
  }

  const origRots = new Map();
  for (const s of S.pageOrder) {
    if (!origRots.has(s.src)) origRots.set(s.src, (await S.pdfDoc.getPage(s.src + 1)).rotate);
  }

  S.pageOrder.forEach((slot, i) => {
    const p = copied[i];
    p.setRotation(PDFLib.degrees((origRots.get(slot.src) + slot.rot) % 360));
    out.addPage(p);
    for (const a of (S.anns.get(slot.src) || [])) drawAnn(p, a, fontObjs, helv, embeddedFonts, embeddedFk);
  });

  return await out.save();
}

function resolveFont(a, fontObjs, helv) {
  const f = fontObjs.get(fontFileFor(a));
  if (f) return f;
  return /[^\x00-\x7F]/.test(a.text || '') ? (fontObjs.get('NotoSansSC-Regular.otf') || helv) : helv;
}

function drawAnn(page, a, fontObjs, helv, embeddedFonts, embeddedFk) {
  const color = hexRgb(a.color || '#f6d743');
  if (a.type === 'highlight') {
    for (const r of a.rects) {
      page.drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color, opacity: 0.4 });
    }
  } else if (a.type === 'underline' || a.type === 'strike') {
    for (const r of a.rects) {
      const { y, th } = markLine(a.type, r);
      page.drawLine({ start: { x: r[0], y }, end: { x: r[2], y }, thickness: th, color });
    }
  } else if (a.type === 'rect') {
    page.drawRectangle({ x: a.x1, y: a.y1, width: a.x2 - a.x1, height: a.y2 - a.y1, borderColor: color, borderWidth: a.sw || 2 });
  } else if (a.type === 'ink') {
    for (let i = 1; i < a.points.length; i++) {
      page.drawLine({
        start: { x: a.points[i - 1][0], y: a.points[i - 1][1] },
        end: { x: a.points[i][0], y: a.points[i][1] },
        thickness: a.sw || 2.5, color, lineCap: PDFLib.LineCapStyle.Round,
      });
    }
  } else if (a.type === 'edit') {
    // 涂白原文，再按原基线/字号/映射字体画替换文字
    for (const r of a.rects) {
      page.drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color: PDFLib.rgb(1, 1, 1) });
    }
    if (a.text) {
      const sys = resolveFont(a, fontObjs, helv);
      // 按 run 原位绘制：每个 run 用自己的 x/基线/字号/字体（保留原始布局）
      const runs = a.runs || [{
        x: a.rects[0][0],
        baselineY: a.baselineY != null ? a.baselineY : a.rects[0][1] + (a.rects[0][3] - a.rects[0][1]) * 0.22,
        size: a.size, fontName: a.fontName, cur: a.text,
      }];
      for (const r of runs) {
        if (!r.cur) continue;
        let font = sys;
        const key = a.page + ':' + (r.fontName || '');
        const fk = embeddedFk.get(key);
        if (fk && embeddedFonts.has(key)) {
          try {
            // 字形覆盖检查：vendored fontkit 没有 hasCharacter（调用即抛异常→静默降级系统字体），
            // 用 glyphsForString 判 notdef（id 0）
            const hasGlyph = ch => { const gs = fk.glyphsForString(ch); return gs.length > 0 && gs[0].id !== 0; };
            if ([...r.cur].every(hasGlyph)) font = embeddedFonts.get(key);
          } catch (e) {}
        }
        r.cur.split('\n').forEach((line, i) => {
          page.drawText(line, { x: r.x, y: r.baselineY - i * r.size * 1.25, size: r.size, font, color: hexRgb(a.color || '#1a1a1a') });
        });
      }
    }
  } else if (a.type === 'text' && a.text) {
    const lines = a.text.split('\n');
    const font = resolveFont(a, fontObjs, helv);
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: a.x1, y: a.y2 - a.size * 0.8 - i * a.size * 1.25,
        size: a.size, font, color,
      });
    });
  }
}

async function saveBytes(bytes, name) {
  if (TAURI) {
    const path = await ti('dialog_save_pdf', { defaultName: name });
    if (!path) return false; // 用户取消
    await writeBytesTauri(path, bytes);
    // 在另存为里选中了原文件 = 变相写回，同样要重建状态（否则后续保存错位/重影）
    if (S.srcPath && normPath(path) === normPath(S.srcPath)) {
      clearDirty();
      clearTimeout(sessionSaveTimer);
      await idbDel(S.sessionKey);
      if (await reloadAfterInPlaceWrite()) toast('已保存（覆盖原文件）：' + S.docName);
    } else {
      toast('已导出：' + path.replace(/^.*[\\/]/, ''));
    }
    return true;
  }
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
    } catch (e) {
      if (e && e.name === 'AbortError') return false; // 仅选择器取消不算写入失败
      throw e;
    }
    const w = await handle.createWritable();
    try { await w.write(bytes); await w.close(); }
    catch (err) { try { await w.abort(); } catch (e) {} throw err; }
    toast('已导出：' + handle.name);
    return true;
  }
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = $('#downloadLink');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('已下载：' + name);
  return true;
}
