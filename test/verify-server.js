// 直接运行服务器的请求回调：白名单、畸形路径、链接越界与监听地址。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

let handler;
let boundHost;
let linkedTarget = null;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), {
  __dirname: ROOT, process: { argv: ['node', 'server.js', '5175'] }, console: { log() {} }, URL,
  require(name) {
    if (name === 'http') return {
      createServer(callback) {
        handler = callback;
        return { listen(port, host) { boundHost = host; } };
      },
    };
    if (name === 'fs') return {
      realpath(file, callback) {
        if (linkedTarget) callback(null, linkedTarget);
        else fs.realpath(file, callback);
      },
      readFile: fs.readFile,
    };
    return require(name);
  },
});

function request(url) {
  return new Promise(resolve => {
    let status, headers;
    handler({ url }, {
      writeHead(code, values) { status = code; headers = values; },
      end(body) { resolve({ status, headers, body }); },
    });
  });
}

(async () => {
  assert.strictEqual(boundHost, '127.0.0.1');
  for (const url of ['/', '/app/app.js', '/vendor/pdf.min.js', '/test/sample.pdf']) {
    const response = await request(url);
    assert.strictEqual(response.status, 200, url);
    assert(response.body.length > 0, url);
  }
  assert.strictEqual((await request('/test/sample.pdf')).headers['Content-Type'], 'application/pdf');
  for (const url of ['/README.md', '/.git/config', '/src-tauri/Cargo.toml', '/test/all.js',
    '/app/%2e%2e%5cREADME.md', '/app/%2e%2e%5c%2e%2e%5cprivate.txt', '/test/nested/file.pdf']) {
    assert.strictEqual((await request(url)).status, 403, url);
  }
  assert.strictEqual((await request('/app/missing.js')).status, 404);
  assert.strictEqual((await request('/%')).status, 400);
  assert.strictEqual((await request('/app/%00.js')).status, 400);
  // 无需在 Windows 创建需权限的符号链接，模拟 realpath 的真实解析结果。
  for (const target of [path.join(ROOT, 'README.md'), path.resolve(ROOT, '..', 'private.txt')]) {
    linkedTarget = target;
    assert.strictEqual((await request('/app/link.txt')).status, 403, target);
  }
  console.log('✓ 本地服务器监听地址与文件白名单通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
