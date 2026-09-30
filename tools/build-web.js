// 把前端（app/ + vendor/）拷进 dist/，供 Tauri 打包嵌入。
// 不能直接把 frontendDist 指到仓库根：会把 node_modules/、src-tauri/ 一起嵌进 exe。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
for (const dir of ['app', 'vendor']) {
  fs.cpSync(path.join(root, dir), path.join(dist, dir), { recursive: true });
  console.log('copied', dir);
}
