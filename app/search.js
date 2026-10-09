
// ---------------- 搜索 ----------------
let searching = false;
let searchQueued = null; // 搜索进行中到达的输入：{q, step} 排队待补搜（含回车跳转意图）
let searchState = { q: '', results: [], cur: -1 };
let searchCase = false, searchHLAll = true;
let searchDebounce = null;

// 搜索头部（计数/上下导航/选项）常驻侧栏「搜索」页签，随搜索状态显隐
function showSearchPanel(show) { $('#searchHead').hidden = !show; }
function updateSearchCount() {
  $('#searchCount').textContent = (searchState.cur + 1) + '/' + searchState.results.length;
}
// 打开新文档时重置结果面板（app.js 调用；输入框由调用方清空）
function resetResultsPanel() {
  updateSearchCount(); showSearchPanel(false);
  $('#resultList').innerHTML = '<div class="muted pad">输入关键词后回车搜索</div>';
}
function clearSearch(clearInput = true) {
  searchState = { q: '', results: [], cur: -1 };
  if (clearInput) $('#searchBox').value = '';
  resetResultsPanel();
  for (const slot of [...S.views.keys()]) renderAnnotations(slot);
}

// 输入即搜（防抖）：现代查看器（Edge/Firefox）的标准行为
$('#searchBox').addEventListener('input', e => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  if (!q) { clearSearch(false); return; }
  searchDebounce = setTimeout(() => doSearch(q), 280);
});
$('#searchBox').addEventListener('focus', () => {
  if (searchState.results.length || $('#searchBox').value.trim()) showSearchPanel(true);
});
$('#searchBox').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch($('#searchBox').value.trim(), e.shiftKey ? -1 : 1);
  else if (e.key === 'Escape') {
    e.target.blur(); clearSearch();
    $('.search-wrap').classList.remove('search-open');
  }
});
$('#searchHead').addEventListener('click', e => {
  const b = e.target.closest('button[data-rnav]');
  if (b && searchState.results.length) {
    gotoSearchResult((searchState.cur + +b.dataset.rnav + searchState.results.length) % searchState.results.length);
  }
});
$('#searchCase').addEventListener('change', e => { searchCase = e.target.checked; if (searchState.q) doSearch(searchState.q); });
$('#searchHl').addEventListener('change', e => {
  searchHLAll = e.target.checked;
  for (const slot of [...S.views.keys()]) renderAnnotations(slot);
});

async function doSearch(q, step) {
  const box = $('#resultList');
  if (!q || !S.pdfDoc) return;
  // 同一关键词再次回车 → 跳下一处（Shift+Enter 上一处），不重新全文扫描
  if (step && searchState.q === q && searchState.results.length) {
    gotoSearchResult((searchState.cur + step + searchState.results.length) % searchState.results.length);
    return;
  }
  // 上一次搜索还在跑：最新查询连同回车跳转意图一起排队，跑完自动补搜/跳转
  //（直接丢弃会让结果停在中间态；只排查询不排跳转会吞掉用户的 Enter）
  if (searching) { searchQueued = { q, step: step || 0 }; return; }
  searching = true;
  showSearchPanel(true);
  if ($('#sidebar').classList.contains('collapsed')) toggleSidebar();
  switchTab('results'); // 结果在侧栏页签里，搜索时切过去让用户看得见
  try {
    box.innerHTML = '<div class="muted pad">搜索中…</div>';
    const ql = searchCase ? q : q.toLowerCase();
    const results = [];
    for (let src = 0; src < S.pdfDoc.numPages && results.length < 300; src++) {
      const tc = await getTextContent(src);
      let str = '';
      const parts = []; // 每个文字项的字符区间，用于估算命中位置
      for (const it of tc.items) {
        const s = it.str + (it.hasEOL ? '\n' : '');
        parts.push({ it, start: str.length, end: str.length + s.length });
        str += s;
      }
      const hay = searchCase ? str : str.toLowerCase();
      let idx = 0;
      while ((idx = hay.indexOf(ql, idx)) !== -1 && results.length < 300) {
        results.push({ src, ctx: str.slice(Math.max(0, idx - 25), idx + q.length + 35), rect: matchRect(parts, idx, q.length) });
        idx += ql.length;
      }
      if (src % 8 === 7) await new Promise(r => setTimeout(r, 0));
    }
    searchState = { q, results, cur: -1 };
    renderResults();
    updateSearchCount();
    // 全部高亮随搜索词更新：重绘所有已渲染页
    for (const slot of [...S.views.keys()]) renderAnnotations(slot);
    if (results.length) gotoSearchResult(0); // 搜索完成直接定位到第一处
  } finally {
    searching = false; // 搜索中途换文件等异常也必须释放标志，否则搜索框被永久锁死
    const next = searchQueued; searchQueued = null;
    if (next) doSearch(next.q, next.step || undefined); // 同词+step → 跳下一处；新词 → 重新搜索
  }
}

// 命中位置近似矩形：按文字项内字符均分宽度估算，够用于闪烁定位
function matchRect(parts, idx, len) {
  const p = parts.find(pp => idx >= pp.start && idx < pp.end);
  if (!p || !p.it.width || !p.it.str) return null;
  const it = p.it;
  const charW = it.width / it.str.length;
  const x1 = it.transform[4] + (idx - p.start) * charW;
  const size = Math.hypot(it.transform[0], it.transform[1]) || 10;
  return [x1, it.transform[5] - size * 0.25, x1 + len * charW, it.transform[5] + size];
}

function renderResults() {
  const box = $('#resultList');
  box.textContent = '';
  if (!searchState.results.length) {
    box.innerHTML = '<div class="muted pad">未找到「' + esc(searchState.q) + '」</div>';
    return;
  }
  for (const [i, r] of searchState.results.entries()) {
    const div = document.createElement('div');
    div.className = 'ritem';
    const slot = S.pageOrder.findIndex(s => s.src === r.src);
    const p = document.createElement('span');
    p.className = 'rpage';
    p.textContent = slot >= 0 ? '第' + (slot + 1) + '页' : '(已删页)';
    div.appendChild(p);
    div.appendChild(document.createTextNode(r.ctx.replace(/\s+/g, ' ')));
    div.addEventListener('click', () => gotoSearchResult(i));
    box.appendChild(div);
  }
}

function gotoSearchResult(i) {
  searchState.cur = i;
  const r = searchState.results[i];
  const slot = S.pageOrder.findIndex(s => s.src === r.src);
  if (slot < 0) { toast('该页已被删除'); return; }
  jumpToSlot(slot);
  const items = $$('#resultList .ritem');
  items.forEach((el, k) => el.classList.toggle('current', k === i));
  if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
  updateSearchCount();
  showSearchPanel(true);
  // 全部高亮模式下"当前命中"深色标记随导航移动：重绘可见页
  if (searchHLAll) for (const sl of [...S.views.keys()]) renderAnnotations(sl);
  flashSearchHit(slot, r.rect);
}

// 页面上闪烁显示命中位置（页面可能还在渲染，就绪后再画，2 秒后淡出移除）
function flashSearchHit(slot, rect) {
  if (!rect) return;
  let tries = 10;
  (function attempt() {
    const v = S.views.get(slot);
    const svg = pageEls[slot]?.querySelector('.annotationLayer svg');
    if (!v || !svg) { if (tries-- > 0) setTimeout(attempt, 200); return; }
    const [vx, vy] = v.viewport.convertToViewportPoint(rect[0], rect[3]);
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('class', 'search-flash');
    r.setAttribute('x', vx);
    r.setAttribute('y', vy);
    r.setAttribute('width', (rect[2] - rect[0]) * v.viewport.scale);
    r.setAttribute('height', (rect[3] - rect[1]) * v.viewport.scale);
    svg.appendChild(r);
    setTimeout(() => r.remove(), 2000);
  })();
}
