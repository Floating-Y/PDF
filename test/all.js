// 一键回归：node test/all.js —— 一条命令暴露"改坏了导出布局"
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // 两个脚本内部都用相对路径（app/app.js、vendor/…），必须在根目录跑
let failed = 0;
for (const s of ['verify-export-layout.js', 'repro-embed.js', 'verify-wrap.js']) {
  console.log(`\n===== ${s} =====`);
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit', cwd: ROOT });
  if (r.status === 0) console.log(`✓ ${s} 通过`);
  else { failed++; console.error(`✗ ${s} 失败（exit ${r.status}）`); }
}
console.log(failed ? `\n${failed} 个脚本失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
