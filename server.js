// 零依赖静态服务器：node server.js [端口]
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 5173;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff2': 'font/woff2',
};

// 应用资源与开发用 PDF 夹具可访问，其余仓库文件不对浏览器公开。
function isPublicFile(file) {
  const relative = path.relative(ROOT, file);
  return /^(app|vendor)[\\/]/i.test(relative) || /^test[\\/][^\\/]+\.pdf$/i.test(relative);
}

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) { // 畸形编码（如 /%）会在请求回调里同步抛 URIError，不接住会击穿整个进程
    res.writeHead(400);
    return res.end('bad request');
  }
  if (urlPath.includes('\0')) { res.writeHead(400); return res.end('bad request'); }
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'app/index.html' : urlPath));
  if (!isPublicFile(file)) { res.writeHead(403); return res.end(); }
  fs.realpath(file, (err, realFile) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    // 目录里的链接也不能绕过白名单读到仓库私有文件或仓库外。
    if (!isPublicFile(realFile)) { res.writeHead(403); return res.end(); }
    fs.readFile(realFile, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(realFile).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`PDF 阅读器: http://127.0.0.1:${PORT}`));
