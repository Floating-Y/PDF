// 折行逻辑单测：直接从 app.js 提取真函数 wrapLine（与实现零漂移），用等宽 fit 模拟测量
const fs = require('fs');
const assert = require('assert');

const appSrc = fs.readFileSync('app/app.js', 'utf8');
function extractFn(name) {
  const m = appSrc.match(new RegExp('^function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?^\\}', 'm'));
  if (!m) throw new Error('function not found in app.js: ' + name);
  return m[0];
}
const wrapLine = eval('(' + extractFn('wrapLine') + ')');

const fit10 = t => t.length <= 10;

// 西文：断在词间空格，空格不带入下一行
assert.deepStrictEqual(wrapLine('hello world foo bar', fit10), ['hello', 'world foo', 'bar']);
// 中文无空格：逐字符断
assert.deepStrictEqual(wrapLine('一二三四五六七八九十甲乙', fit10), ['一二三四五六七八九十', '甲乙']);
// 整词放不下：回退到行内最后一个空格
assert.deepStrictEqual(wrapLine('abcdefghij kl mn', fit10), ['abcdefghij', 'kl mn']);
// 超长单词：逐字符硬断，不丢字符
assert.deepStrictEqual(wrapLine('abcdefghijklmnopqrstuvwxyz', fit10),
  ['abcdefghij', 'klmnopqrst', 'uvwxyz']);
// 空串、首字符即超宽、前导空格保留
assert.deepStrictEqual(wrapLine('', fit10), ['']);
assert.deepStrictEqual(wrapLine('ab', t => t.length <= 1), ['a', 'b']);
assert.deepStrictEqual(wrapLine('  leading', fit10), ['  leading']);
// 折行不丢字符（忽略被断行吃掉的空格）
for (const s of ['hello world foo bar', '一二三四五六七八九十甲乙', 'a  b   c', 'aaaa bbbb cccc', 'x']) {
  const lines = wrapLine(s, fit10);
  assert.strictEqual(lines.join('').replace(/ /g, ''), s.replace(/ /g, ''), s);
}
console.log('✓ wrapLine 折行逻辑通过');
