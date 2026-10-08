// 一键回归：node test/all.js —— 导出布局、保存恢复与本地服务
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // 部分脚本使用相对路径，必须在根目录跑
let failed = 0;
for (const s of ['verify-export-layout.js', 'repro-embed.js', 'verify-wrap.js', 'verify-save-session.js', 'verify-server.js']) {
  console.log(`\n===== ${s} =====`);
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit', cwd: ROOT });
  if (r.status === 0) console.log(`✓ ${s} 通过`);
  else { failed++; console.error(`✗ ${s} 失败（exit ${r.status}）`); }
}
// 浏览器版不用 Rust；安装桌面工具链后同一入口也检查真实文件写入函数。
if (spawnSync('rustc', ['--version'], { stdio: 'ignore' }).status === 0) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'verify-desktop-io.js')], { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0) failed++;
} else console.log('跳过桌面文件自检：未安装 rustc');
console.log(failed ? `\n${failed} 个脚本失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
