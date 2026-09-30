# PDF Reader

A fully local PDF reader: read, annotate, edit text, manage pages, export.
Built for personal use — deliberately feature-light, extensible by staying simple
(development conventions in [AGENTS.md](AGENTS.md)). No npm runtime dependencies,
no build step, works offline. Files never leave your machine.

## Running

**Browser edition**: double-click `start.bat` (or `node server.js 5175`), then open
http://127.0.0.1:5175 — Chrome/Edge recommended.

**Desktop edition** (Windows, Tauri 2):

```
npm install     # only the Tauri CLI (a build tool, not a runtime dependency)
npm run dev     # development
npm run build   # NSIS installer in src-tauri/target/release/bundle/nsis/
```

Both editions share the same `app/` frontend. The desktop edition adds a custom title
bar, Ctrl+S write-back to the original file (automatic `.bak` backup on the first
overwrite), `.pdf` file association, single instance, and native dialogs.

## Usage

- **Read** — open via the button or drag a PDF in. Continuous scrolling, zoom
  (Ctrl+wheel anchored at the cursor / preset dropdown / fit-width / fit-page /
  Ctrl+drag to zoom into a region), a hand tool for drag-panning (H, or hold
  Space), page jumping, outline and thumbnail sidebars, Ctrl+F full-text search,
  Ctrl+P print. F1 lists all shortcuts; the zoom level is remembered across
  sessions.
- **Annotate** — select text to get the floating toolbar (copy / highlight /
  replace), or use the box / freehand / text tools. Annotations can be selected,
  dragged, recolored, deleted (Del), and undone (Ctrl+Z / Ctrl+Y).
- **Right-click a page** — the context menu follows the target: selected text
  (copy / highlight / replace), an annotation (recolor / delete), or the page
  itself (rotate / delete / print).
- **Edit text** — the "✏️ Edit text" tool rewrites a clicked line in place, reusing
  the PDF's own embedded font so the result is indistinguishable from the original.
- **Pages** — rotate, delete, and reorder pages via the "⋯" menu or the thumbnail
  sidebar (takes effect on export).
- **Export** — "💾 Export" saves a new PDF with all changes baked in; the original
  file is untouched. Unsaved changes are guarded (orange dot + close confirmation),
  and editing sessions autosave to IndexedDB — after a crash, the start page offers
  to resume where you left off.

## Structure

```
app/        frontend shared by both editions — index.html, app.js (all logic), style.css
vendor/     pdf.js, pdf-lib, fontkit + open-source fonts (versions pinned, offline)
src-tauri/  desktop shell (Tauri 2) — custom commands, single instance, file association
tools/      build and fixture generators (build-web, gen-icon, gen-test-pdf*)
test/       regression scripts and fixtures
server.js   zero-dependency static server (browser edition)
start.bat   one-click launcher for the browser edition
```

`node test/all.js` runs the regression suite.

## License

Code is [MIT](LICENSE). Vendored components keep their licenses in-tree: pdf.js
(Apache-2.0), pdf-lib and fontkit (MIT), Liberation and Noto fonts (SIL OFL 1.1) —
see `vendor/*/LICENSE*`.
