// 不依赖 Tauri 下载：直接编译 main.rs 中的文件 I/O 与参数解析自检。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');
const helpersStart = source.indexOf('fn validate_temporary_path(');
const helpersEnd = source.indexOf('// 前端等所有脚本');
const testsStart = source.indexOf('#[cfg(test)]');
assert(helpersStart >= 0 && helpersEnd > helpersStart && testsStart > helpersEnd, '桌面自检源代码范围无效');
const standaloneSource = source.slice(helpersStart, helpersEnd) + source.slice(testsStart);
const targetDirectory = path.resolve(__dirname, '../src-tauri/target');
fs.mkdirSync(targetDirectory, { recursive: true });
const testDirectory = fs.mkdtempSync(path.join(targetDirectory, 'io-test-'));
try {
  const sourcePath = path.join(testDirectory, 'files.rs');
  const executablePath = path.join(testDirectory, 'files-test.exe');
  fs.writeFileSync(sourcePath, standaloneSource);
  execFileSync('rustc', ['--edition=2021', '--test', sourcePath, '-o', executablePath], { stdio: 'inherit' });
  execFileSync(executablePath, [], { stdio: 'inherit' });
} finally {
  // 只清理本次创建且仍位于 target 内的目录。
  const relative = path.relative(fs.realpathSync(targetDirectory), fs.realpathSync(testDirectory));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '拒绝清理 target 外的目录');
  fs.rmSync(testDirectory, { recursive: true, force: true });
}
