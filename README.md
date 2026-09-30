# PDF Reader (Reading + Editing)

A fully local PDF reader: read, annotate, edit text, manage pages, export. No npm runtime dependencies, works offline.
**Two editions**: browser (zero-dependency static server) + desktop (Tauri, `npm run build` produces an installer).

## Running

Browser edition: double-click `start.bat`, or run `node server.js 5175` manually, then open http://127.0.0.1:5175 (Chrome/Edge recommended).

Desktop edition (Windows, Tauri 2 + WebView2):

```
npm install        # only installs @tauri-apps/cli (a build tool, not a runtime dependency)
npm run dev        # development
npm run build      # produces the NSIS installer (src-tauri/target/release/bundle/nsis/)
```

The desktop edition adds: **a custom-drawn title bar** (no native frame — the toolbar doubles as the title
bar: drag to move, double-click to maximize/restore, top-right minimize/maximize/close buttons match the
app theme, close hover uses the app red), **Ctrl+S writes back to the original file** (a `.bak` backup is
created automatically before the first overwrite), double-click `.pdf` file association, single instance
(a second launch hands its file to the running window), native open/save dialogs, drag-and-drop files into
the window, and unsaved-changes confirmation on close.
The `app/` frontend code is shared by both editions; every desktop branch is contained in a `window.__TAURI__` check.

## Features

**Reading**
- Open: button (system file picker) or drag a PDF into the window; **recent files** list (file handles
  stored in IndexedDB; one-click reopen in Chrome/Edge, requires granting permission); toasts show
  progress during open/export
- Continuous scrolling + lazy rendering, page-number jump (prev/next buttons auto-disable at the
  first/last page), zoom (buttons / Ctrl+wheel / **preset dropdown 50%–200%** / fit-width / fit-page;
  fit modes recompute on window resize); clicking the zoom label to restore 100% is merged into the dropdown
- Text selection and copy; **after selecting text, a floating toolbar appears next to the selection
  (highlight / replace text)** — act in place instead of reaching for the toolbar
- Full-text search (Ctrl+F): **search-as-you-type (280ms debounce)**, the dropdown panel shows the
  **hit count 1/N with previous/next**, **case sensitivity**, and **highlight all** (all hits in light
  blue, the current hit in dark blue with an outline that follows navigation); Enter for next,
  Shift+Enter for previous; the sidebar "Search" tab keeps the full result list
- Outline navigation (sidebar "Outline" tab)
- Thumbnail sidebar (**skeleton screen + progressive rendering**; the current page's blue frame is
  visible immediately), click to jump; the sidebar collapses via a toolbar button
- Keyboard shortcuts: ←/→/PgUp/PgDn smooth paging, Home/End first/last page, Ctrl+F search, Ctrl+P
  print, Ctrl+= / Ctrl+- zoom, Del deletes the selected annotation, Ctrl+Z undo / Ctrl+Y (Ctrl+Shift+Z)
  redo, Esc cancels the selection and returns to the select tool, F1 shortcut help
- Print (Ctrl+P / "⋯" menu): prints the original file directly when unmodified; with unsaved changes,
  runs the export pipeline first (annotations/deleted pages/rotations all applied), then prints
- Dark / light theme toggle (rightmost toolbar button, choice remembered; light-theme contrast
  calibrated for accessibility)

**Annotations (written into the PDF on export)**
- **Undo / redo**: toolbar buttons + shortcuts, annotation-level (add/delete/move/text edits are all reversible)
- Edit text (like Foxit): click "✏️ Edit text" to enter the mode, then click a text line on the page →
  the whole line is painted white and an editable text box appears in place (it picks up the original
  font size and color, prefills the original text and **reconstructs spaces from the original word
  positions**, and places the cursor where you clicked); click elsewhere or press Esc to commit; clearing
  the text deletes the original; exiting without changes leaves no trace; double-click to edit again
- **The PDF's run structure is preserved**: on commit, a character-level diff (LCS) distributes the new
  text back into the original runs — each run is redrawn at its own original x position in its own
  original font. Change one word and the other words stay exactly in place, matching the original line
  layout; **when a run's actual content grows longer, the whole line reflows as a single run** (an
  in-place redraw would collide with the next run's original position; the result matches the editing
  preview's layout, with no overlap)
- Replace text (partial): select a passage → floating toolbar or "✎ Replace" swaps out only the selection
- Text: click "🅣 Text", then click on the page to place a text box; type, then Esc or click elsewhere to
  commit; double-click to edit again
- Highlight: selecting text highlights it (auto-applied on mouse-up with the highlight tool active, or
  via the selection floating toolbar / "🖍 Highlight" button)
- How text editing works: "paint white + redraw in place". PDF glyphs are drawn by coordinates with
  subset-embedded fonts — the original text objects cannot truly be rewritten (the same is true of any
  PDF editor). To make edits indistinguishable from the original, replaced text **reuses the font
  program embedded in the PDF** (preview via FontFace; on export the original font is re-embedded in
  the output file, so glyphs are 100% identical to the original); preview and export share the same
  font-fallback rule — when an input character is missing from the original subset, **the entire
  run/line** degrades together to a mapped open-source font (Western fonts map per pdf.js's
  classification to Liberation Serif/Sans/Mono — the metric-compatible open-source replacements for
  Times/Arial/Courier; Chinese maps to Noto Sans SC, and the preview loads and the export embeds **the
  same font file**, so both render identical glyphs). Baseline and font size come from the PDF's exact
  internal coordinates; the white rectangle extends 1pt outward to cover glyph-edge remnants. New text
  overflowing the original line extends to the right; paragraphs do not reflow
- Box / freehand: drag directly after selecting the tool
- Annotations can be selected and dragged, Del deletes, Ctrl+Z undoes; the color bar switches
  yellow/green/red/blue
- Chinese annotations embed Noto Sans SC automatically on export (OFL open-source font; subset
  embedding has minimal size impact)

**Page editing (applied on export)**
- Toolbar "⋯" menu: rotate the current page, delete the current page, shortcut help; thumbnail hover
  buttons also rotate/delete
- Reorder: drag thumbnails in the sidebar to the target position

**Export & safety**
- Toolbar "💾 Export": opens a save dialog and writes a new PDF (the original file is untouched); a toast
  shows progress (font embedding is slow for large files)
- **Unsaved-changes guard**: the export button shows an orange dot; closing the page with unsaved
  changes asks for confirmation (beforeunload)
- **Crash recovery (editing-session autosave)**: every change is saved to IndexedDB after an 800ms
  debounce (keyed by filename+size). After a crash, a killed process, or an accidental close, the start
  page shows an "unsaved changes" banner — one click resumes editing (the original file's bytes are
  archived, so no need to locate the file again); reopening the same file also restores automatically.
  A successful export, reverting to the original, or clicking "discard" clears the session (including
  the byte archive — no leftover copies)
- **Encrypted PDFs**: opening a password-protected PDF prompts for the password (retry on a wrong one,
  cancellable); corrupt files get a clear message instead of a raw error. Note: encrypted files are
  read-only; export explicitly reports it as unsupported
- The document name stays in the browser tab title (`filename — PDF Reader`)

## Structure

```
server.js               zero-dependency static server (browser edition; the desktop edition is served
                        directly by Tauri's asset protocol)
app/index.html          page skeleton
app/app.js              all logic (single file, including the desktop __TAURI__ branches)
app/style.css           styles
vendor/                 pdf.js 3.11.174, pdf-lib 1.17.1, fontkit
                        ├ cmaps/, standard_fonts/: required to render PDFs without embedded fonts
                        │   (CJK CID fonts, the standard 14 fonts)
                        └ fonts/: fonts embedded on annotation export — Liberation Serif/Sans/Mono
                            (metric-compatible open-source replacements for Arial/Times/Courier; the
                            preview renders with the system font name, the export embeds the matching
                            Liberation file) + Noto Sans SC (Chinese); all OFL-licensed and
                            redistributable (LICENSE-*.txt)
src-tauri/              desktop edition (Tauri 2): main.rs with four custom commands (dialogs/read/
                        chunked write+backup), single instance + file association; capabilities grant
                        only core window/event permissions
tools/build-web.js      copies app/ + vendor/ into dist/ for packaging (avoids embedding node_modules)
tools/gen-icon.js       generates the icon source image (a hand-written PNG encoder in plain node)
tools/gen-test-pdf*.js  regenerate the test fixtures: sample (basic), sample-embedded (embedded fonts,
                        per-word positioning), cmap/gbk-nonembedded (non-embedded CJK, verifies the
                        cMaps configuration)
test/desktop-e2e.mjs    desktop-edition end-to-end verification (CDP-driven WebView2)
test/sample.pdf         test document (regenerate with node tools/gen-test-pdf.js)
test/all.js             one-command regression (runs verify-export-layout / repro-embed / verify-wrap)
```

## Verified

Opening/rendering/zoom/paging, annotation add/delete/move with undo/redo (the full chain: add/delete/
move/text edits), the edit-text mode (click a line to edit in place, **per-word original positions
preserved**, character-level diff distribution, re-entering doesn't duplicate, an unchanged exit leaves
no trace), replace text (including Chinese), rotate/delete/reorder pages, full-text search (live
search, highlight all, case sensitivity, hit count and prev/next navigation), the zoom preset dropdown
and fit-page, the selection floating toolbar (highlight/replace), disabled states on the first/last
page, recent files (handle storage), the unsaved-changes dot and close confirmation, the export
round-trip (annotations, text edits, rotation, deletions, reordering, Chinese, and original-font glyphs
all persist), and the full crash-recovery chain (draw annotation → debounced save → banner on reopen →
resume editing with annotations/page changes/positions restored; discard → IndexedDB cleared with no
leftover copies), printing (menu item; Ctrl+P via a real keypress runs the full export compositing
pipeline).
Editing-consistency regression: `node test/all.js` (a lengthened run → the whole line reflows without
overlap; same length → per-run positions preserved; re-embedded font metrics read back correctly);
browser edit → export → read-back screenshot comparison: same-length replacements align word-by-word
with the original line, lengthened lines reflow naturally, and missing-glyph lines use the same font in
preview and export (test/exported-visual-check.pdf).

Desktop edition (Tauri, `test/desktop-e2e.mjs` all green): the pdf.js worker and 20-page rendering work
under the asset protocol, openPath opens files, CDP drives real-mouse annotation drawing, refresh →
recovery banner → resume editing (both the annotation and write-back paths restore), Ctrl+S write-back
(disk-verified: the saved file is a valid PDF containing the annotations; the .bak is byte-identical to
the original), **multi-round write-back** (document state is rebuilt from disk after saving — a second
save doesn't crash, baking produces no ghosting, docSize matches the on-disk file), fit-width zoom
recomputed on rotation, the unsaved-changes marker cleared after a full undo, custom window controls
(buttons visible, the maximize icon stays in sync, double-clicking the title bar maximizes, the close
button exits), and single-instance file forwarding (a second process launched with a path → the running
window opens it).

### UI/UX revamp (benchmarked against the official pdf.js viewer / Acrobat / Foxit / Sejda)

Ideas adopted from peers: pdf.js's "zoom preset dropdown + state transparency (buttons disabled at the
first/last page) + low-frequency functions tucked into a menu", Acrobat's "selection floating toolbar +
always-visible undo/redo", Sejda's "privacy promise (files never leave your machine)", and the common
editor convention of an "unsaved changes" indicator.
Also fixed: **the full-width white page container bug** (`.page` gets `width: fit-content`; previously
every page rendered as a full-viewport-wide white sheet), light-theme contrast (segmented-control
background/border/active state and color-dot outlines calibrated for accessibility), and the thumbnail
skeleton screen (the current page's blue frame no longer waits for all renders to finish).

### Troubleshooting log (edit text "didn't match expectations")

1. When a run's content grows, an in-place redraw collides with the next run's original position → the
   whole line reflows as a single run on commit (same layout as the editing preview).
2. The preview's font fallback used per-character browser fallback while the export was all-or-nothing
   per run → the preview now uses `document.fonts.check` with the same rule.
3. The vendored fontkit lacks a `hasCharacter` method; the export-side glyph-coverage check threw and
   the exception was swallowed → **all replaced text was silently degrading to the mapped system fonts
   (Arial/SimHei)**, and because Arial is wider, per-run in-place drawing bunched up. After switching to
   `glyphsForString` and checking for notdef (id 0), original-font reuse actually works.
4. An occasional "page canvas rendering hangs forever" in tests: Chrome heavily throttles Web Workers
   when the browser panel loses focus; after a render timeout (20s) the render is cancelled and retried,
   and in pdf.js 3.11 a cancelled page object can deadlock on re-render (that page never renders again).
   This is environment + upstream known behavior; switching the panel to the foreground and opening a
   new file recovers. Upgrading pdf.js, or rebuilding the whole document after a render timeout, avoids
   it entirely.
5. **State rebuild after writing back to the original file (desktop)**: after Ctrl+S bakes annotations
   into the file, if pdfDoc/pageOrder/anns still hold the pre-write state, a later save indexes the new
   document with old page indices (a copyPages out-of-bounds crash) or draws the already-baked
   annotations again (ghosting). Fix: after a successful write-back, reopen from disk (openPath) — the
   annotations are naturally visible as page content, and the cleared undo stack marks the save point;
   a save-as onto the original file (same path) takes the same route. A write-back changes the file
   size → the session key (name:size) refreshes with it, so crash recovery doesn't mismatch. Other
   fixes along the way: the latest input during an in-progress search is queued and re-searched,
   fit-width/fit-page zoom recomputes on rotation, and the unsaved-changes marker auto-clears after a
   full undo.

## Implementation notes (rendering robustness)

- Rendering goes through a serial queue (the worker runs one render at a time); page/text-layer/
  thumbnail renders all have timeout-based self-healing (hang → cancel → retry), and consecutive
  failures back off with delayed retries (up to 5 per slot)
- Reopening a file destroys the old document and releases the worker, preventing resource accumulation
- Note: when the browser panel is obscured or in the background, Chrome heavily throttles Web Workers
  (measured 4–8×+ slower) — rendering appears slower; bringing the panel to the foreground restores
  full speed. This is not a bug

## Deferred (add when needed)

- Automation features that control the machine's mouse/keyboard (out of scope for now)
- Page-level undo (delete/reorder/rotate are currently not undoable; deletion has a confirmation dialog)
- Blank-page insertion, OCR for scanned documents, form filling, encrypted-PDF export

## License

This project's code is released under the [MIT](LICENSE) license. Third-party components distributed
with the source (`vendor/`):

| Component | License | Purpose |
| --- | --- | --- |
| pdf.js 3.11.174 | Apache-2.0 | PDF rendering |
| pdf-lib 1.17.1 | MIT | PDF generation/export |
| fontkit | MIT | Font parsing/subsetting |
| Liberation Serif/Sans/Mono | SIL OFL 1.1 | Metric-compatible open-source replacements for Arial/Times/Courier (`vendor/fonts/LICENSE-Liberation.txt`) |
| Noto Sans SC | SIL OFL 1.1 | Chinese fallback and embedded font (`vendor/fonts/LICENSE-NotoSansSC.txt`) |
| cmaps / standard_fonts | shipped with pdf.js (Apache-2.0 / Foxit / Liberation) | `vendor/cmaps/LICENSE`, `vendor/standard_fonts/LICENSE_*` |
