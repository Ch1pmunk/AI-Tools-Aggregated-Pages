/**
 * AI 工具导航 —— 静态服务器
 * ---------------------------------------------------------------------------
 * 零依赖，只用 Node 内置模块。
 *
 * 这个服务**只发页面和前端资源，不发数据**。工具数据在另一个服务上（见 data-service/），
 * 端口也不同 —— 页面通过 /api/config 问它「数据服务在哪」，所以这里改端口、那边改端口，
 * 都不需要动前端代码。
 *
 * 路由（严格白名单，其余地址一律 404）：
 *   /                首页
 *   /tools           AI 工具页
 *   /search          搜索结果页（缺 q 时 302 回 /tools）
 *   /assets/*        前端资源（css / js），另一张白名单，见下
 *   /tools/<项目名>/* 本地工具本体，托管 tools/<项目名>/ 下的文件
 *   /api/config      前端读取配置（本服务地址 + 数据服务地址）
 *
 * 注意 `/tools` 与 `/tools/<项目名>` 是两件不同的事，共用同一个前缀但不冲突：
 *   /tools      精确匹配 → 工具页（页面的路由表里的一行）
 *   /tools/ppt/ 有第二段 → 去 tools/ppt/ 找文件
 * 判据就是「前缀之后还有没有东西」，所以 /tools/ 落回页面、/tools/ppt/ 走托管。
 *
 * 启动：
 *   node server.js                      或     npm run start:static
 *
 * 备选启动命令（自定义 IP / 端口）：
 *   HOST=127.0.0.1 PORT=3000 node server.js
 * 或只用 Python 起一个静态服务（仅需托管 index.html 时够用，但**没有数据服务**，
 * 页面会显示「未能读取工具数据」——这是预期表现，不是坏了）：
 *   python3 -m http.server 3000 --bind 127.0.0.1
 * ---------------------------------------------------------------------------
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================== SERVER 配置 ==============================
const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || 3000;
// 修改这里，或启动时设置环境变量 HOST / PORT，即可自定义 IP 和端口。
// 例：PORT=8080 node server.js  →  http://127.0.0.1:8080
//
// 数据服务在哪 —— 只用于告诉浏览器，本服务自己不连它。
// 用一条命令同时起两个服务时（npm start），这个值由 scripts/start.js 按 DATA_HOST/DATA_PORT 算好传进来，
// 所以改数据服务端口只需要改一处。
const DATA_ORIGIN = process.env.DATA_ORIGIN || 'http://127.0.0.1:3001';
// ========================================================================

const ROOT = __dirname;                // 站点根目录（本文件所在目录）
const INDEX_FILE = 'index.html';       // 首页与工具页都由它渲染
const ASSETS_DIR = path.join(ROOT, 'assets');
const ASSETS_PREFIX = '/assets/';
const TOOLS_DIR = path.join(ROOT, 'tools');
const TOOLS_PREFIX = '/tools/';

/**
 * 页面路由表：路径 → { 实际文件, 导航名 }。
 * 首页挂在根路径上（访问 / 即直达首页）；工具页固定在 /tools；搜索结果页在 /search。
 * 以后若要新增页面，在这里加一行即可 —— 路由匹配和 404 页的出口链接都由这张表推导，
 * 不存在「页面加了、404 页还写着本站只有几个页面」这种会过期的说法。
 * nav 为 null 表示该页面必须带参数才有意义，不列进 404 页的出口。
 * 注意：只登记页面路径，不要登记 assets 之类的通配，否则会绕开 404 规则、
 * 也会让 404 页的出口多出不是页面的东西。
 */
const ROUTES = {
  '/':       { file: INDEX_FILE, nav: '首页' },
  '/tools':  { file: INDEX_FILE, nav: 'AI 工具页' },
  '/search': { file: INDEX_FILE, nav: null }
};

/** 静态资源 MIME 映射。**同时是 /assets 的扩展名白名单** —— 不在表里的扩展名不托管 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2'
};

/**
 * 本地工具本体用**另一张** MIME 表 —— 比前端资源那张宽。
 * 前端资源只有我们自己的那几个文件，收得紧一点没成本；而 tools/ 下是别人项目的成品，
 * 收得太紧会「明明文件在却打不开」，而且错得很安静（浏览器拿到 octet-stream 就下载/白屏）。
 * 仍然是白名单：不在表里的扩展名一律 404。
 */
const PROJECT_MIME = Object.assign({}, MIME, {
  '.mjs':         'text/javascript; charset=utf-8',
  '.cjs':         'text/javascript; charset=utf-8',
  '.map':         'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt':         'text/plain; charset=utf-8',
  '.md':          'text/plain; charset=utf-8',
  '.csv':         'text/csv; charset=utf-8',
  '.xml':         'application/xml',
  '.gif':         'image/gif',
  '.webp':        'image/webp',
  '.avif':        'image/avif',
  '.woff':        'font/woff',
  '.ttf':         'font/ttf',
  '.otf':         'font/otf',
  '.eot':         'application/vnd.ms-fontobject',
  '.wasm':        'application/wasm'
});

/**
 * 这些扩展名每次都回源校验。
 * 本地开发工具，改完 css/js 刷新页面却还是旧文件，是真实会反复踩的坑。
 */
const NO_CACHE_EXTS = new Set(['.html', '.js', '.css']);

/** 当前服务地址（页面通过 /api/config 读取，避免在页面里写死地址） */
function serverUrl() {
  const host = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  return `http://${host}:${PORT}`;
}

/** 转义，防止把请求路径原样回显到 404 页面时被注入 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 404 页的出口链接：从路由表推导，新增页面后这里自动多一个出口，无需改本函数 */
function navLinksHtml() {
  return Object.keys(ROUTES)
    .filter(p => ROUTES[p].nav)
    .map((p, i) => `<a${i === 0 ? ' class="primary"' : ''} href="${p}">${escapeHtml(ROUTES[p].nav)}</a>`)
    .join('\n      ');
}

/** 出错页共用的外壳与样式：与站点同一套米白 / 瑞士风视觉 */
function errorPage({ title, tag, heading, noteHtml }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    background: #F7F4EE; color: #111111;
    font-family: Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { width: 100%; max-width: 720px; margin: 0 auto; padding: 48px 24px; }
  .tag { margin: 0; font-size: 11px; font-weight: 500; letter-spacing: .24em; text-transform: uppercase; color: #6B7280; }
  h1 { margin: 24px 0 0; font-size: 44px; line-height: 1.1; font-weight: 700; letter-spacing: -.02em; }
  p.note { margin: 20px 0 0; font-size: 15px; line-height: 1.85; color: #6B7280; max-width: 46ch; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #111111; }
  hr { margin: 40px 0 0; border: 0; border-top: 1px solid #E8E3DA; }
  nav { margin-top: 24px; display: flex; flex-wrap: wrap; gap: 10px; }
  nav a {
    padding: 8px 16px; border-radius: 999px; border: 1px solid #E8E3DA;
    background: #FFFFFF; color: #6B7280; text-decoration: none; font-size: 14px;
    transition: background-color .18s ease, color .18s ease, border-color .18s ease;
  }
  nav a:hover { border-color: #111111; color: #111111; }
  nav a.primary { background: #111111; border-color: #111111; color: #FFFFFF; }
</style>
</head>
<body>
  <main>
    <p class="tag">${escapeHtml(tag)}</p>
    <h1>${escapeHtml(heading)}</h1>
    <p class="note">
      ${noteHtml}
    </p>
    <hr />
    <nav>
      ${navLinksHtml()}
    </nav>
  </main>
</body>
</html>`;
}

/** 地址本身不存在 */
function notFoundPage(pathname) {
  const shown = escapeHtml(String(pathname).slice(0, 120));
  return errorPage({
    title: '404 · 页面不存在',
    tag: '404 · Not Found',
    heading: '这里没有页面。',
    noteHtml: `你访问的 <code>${shown}</code> 不存在。`
  });
}

/**
 * `/tools/<项目名>/` 下没有对应的项目文件夹。
 *
 * 这不是「地址写错了」，而是「这条路是对的、只是货还没到」——所以它单独一页，
 * 而不是复用上面那个笼统的 404。判据是**实时**去看一眼 tools/ 下有没有那个目录，
 * 不是写死的文案：将来目录真的放进去了，这里自然就不再出现。
 */
function projectNotFoundPage(projectName) {
  const shown = escapeHtml(String(projectName).slice(0, 80));
  return errorPage({
    title: '404 · 项目不存在',
    tag: '404 · 项目不存在',
    heading: '这个工具还没有本地副本。',
    noteHtml:
      `你访问的是 <code>/tools/${shown}/</code>，但 <code>tools/</code> 下没有这个项目文件夹。<br />
       本地工具的本体放在 <code>tools/&lt;项目名&gt;/</code>：把开源项目的 zip 下载、解压到
       <code>tools/${shown}/</code>，这个地址就能直接打开。`
  });
}

/** 同步判断是不是目录（不存在、没权限，都当不是） */
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (err) { return false; }
}

/** 同步判断是不是文件 */
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (err) { return false; }
}

/** 统一发送响应；HEAD 请求只给响应头，不发正文 */
function send(req, res, status, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length
  }, headers || {}));
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function notFound(req, res, pathname) {
  const page = notFoundPage(pathname);
  send(req, res, 404, page, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

/** 「这个工具还没有本地副本」——地址对，只是 tools/ 下没有那个项目 */
function projectNotFound(req, res, projectName) {
  const page = projectNotFoundPage(projectName);
  send(req, res, 404, page, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

/**
 * 读取并下发一个文件。
 * options.mime        用哪张 MIME 表（默认前端资源那张，tools/ 下传 PROJECT_MIME）
 * options.alwaysFresh 整个目录都不缓存（tools/ 下用：本地工具本体是维护者自己刚放进去、
 *                     还在改的东西，改完刷新就该看到，不该跟浏览器缓存较劲）
 */
function sendFile(req, res, filePath, options) {
  const table = (options && options.mime) || MIME;
  const alwaysFresh = !!(options && options.alwaysFresh);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') {
        notFound(req, res, req.url);
        return;
      }
      console.error(`[500] ${req.method} ${req.url} — 无法读取 ${filePath}：${err.message}`);
      send(req, res, 500, '500 Internal Server Error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': table[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      // nosniff：不让浏览器自己猜类型。tools/ 下放的是别人的项目文件，
      // 少一个「把 .txt 猜成 HTML 然后执行」的口子。
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': (alwaysFresh || NO_CACHE_EXTS.has(ext)) ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/**
 * /assets/* —— 前端资源，另一张白名单，与页面路由表彻底分开。
 *
 * 两条硬规则：
 *   1. 解析结果必须落在 assets/ 目录内，否则一律 404（防 `..` 和 `%2e%2e` 穿越）
 *   2. 扩展名必须在 MIME 表里，不在就不托管
 *
 * 顺带的好处：`/catalog/*`、`/data-service/*`、`/docs/*`、`/Readme.md`
 * 因为都不在白名单里，天然全部 404 —— 数据文件、源码和文档永远不会被浏览器拿走。
 * （`/tools/<项目名>/` 是**另一张**白名单，见 sendProject —— 只有它下面那一个子树是对外的。）
 */
function sendAsset(req, res, pathname) {
  const rel = pathname.replace(/^\/assets\/?/, '');
  const filePath = path.resolve(ASSETS_DIR, rel);

  if (filePath !== ASSETS_DIR && !filePath.startsWith(ASSETS_DIR + path.sep)) {
    notFound(req, res, pathname);
    return;
  }
  if (!MIME[path.extname(filePath).toLowerCase()]) {
    notFound(req, res, pathname);
    return;
  }
  sendFile(req, res, filePath);
}

/**
 * `/tools/<项目名>/*` —— 本地工具本体。
 *
 * 这是「工具卡片被点击之后发生的事」：卡片的 url 填 `/tools/<项目名>/`，
 * 点开就走到这里，由本服务把 tools/<项目名>/ 下的文件发给浏览器。
 *
 * 与 /assets 同样是白名单，但两处不同：
 *   1. 这里**有目录的概念** —— 请求一个目录就找它的 index.html（静态站点的常规做法）
 *   2. 少了 index.html 或者整个项目文件夹都不在时，给的是**专门的提示页**，
 *      而不是笼统的「这里没有页面」（见 projectNotFoundPage）
 *
 * 安全边界：
 *   - 解析结果必须落在 tools/ 内（防 `..` 与 `%2e%2e`），否则一律不认
 *   - 扩展名必须在 PROJECT_MIME 里
 *   - **不出目录列表** —— 请求目录只给 index.html，没有就 404
 *
 * ⚠️ tools/ 下放的 HTML/JS 是**在本站源下执行**的，不是沙箱。
 *    只往这里放你信得过的项目 —— 详见 tools/README.md。
 */
function sendProject(req, res, pathname) {
  const relPath = pathname.slice(TOOLS_PREFIX.length);   // 前缀之后的部分，非空
  const projectName = relPath.split('/')[0];
  const projectDir = path.resolve(TOOLS_DIR, projectName);

  // 第一段就是项目名，它必须落在 tools/ 之内
  if (projectDir !== TOOLS_DIR && !projectDir.startsWith(TOOLS_DIR + path.sep)) {
    projectNotFound(req, res, projectName);
    return;
  }

  // 项目文件夹不在 —— 就是「/tools 没有对应项目文件夹」那个情况
  if (!isDir(projectDir)) {
    projectNotFound(req, res, projectName);
    return;
  }

  let filePath = path.resolve(TOOLS_DIR, relPath);

  // 请求的是一个目录：补斜杠 + 找它的 index.html。
  // **补斜杠只对目录做** —— 对文件也跳的话，/tools/ppt/style.css 会先被跳到
  // /tools/ppt/style.css/ 再 404，而请求的是一个明明存在的文件，极难看出是这里的问题。
  if (isDir(filePath)) {
    if (!pathname.endsWith('/')) {
      // 少了这一步，项目页里 `style.css` 这类相对引用会以 /tools/ppt 为基准
      // 解析成 /tools/style.css，表现是「样式全丢」，且看不出跟这个跳转有关系。
      send(req, res, 302, '', {
        Location: encodeURI(pathname) + '/',
        'Cache-Control': 'no-store'
      });
      return;
    }
    filePath = path.join(filePath, 'index.html');   // 不出目录列表
  }

  // 再校验一次：上面拼过 index.html，relPath 里的 .. 仍可能把结果带出 tools/
  if (filePath !== TOOLS_DIR && !filePath.startsWith(TOOLS_DIR + path.sep)) {
    notFound(req, res, pathname);
    return;
  }
  if (!isFile(filePath)) {
    notFound(req, res, pathname);
    return;
  }
  if (!PROJECT_MIME[path.extname(filePath).toLowerCase()]) {
    notFound(req, res, pathname);
    return;
  }

  sendFile(req, res, filePath, { mime: PROJECT_MIME, alwaysFresh: true });
}

/** 发送 JSON（配置接口用） */
function sendJson(req, res, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer((req, res) => {
  // 只接受 GET / HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    send(req, res, 405, '405 Method Not Allowed');
    return;
  }

  let pathname, searchParams;
  try {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    searchParams = url.searchParams;   // 查询串不参与路由，但 /search 需要读 q
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch (err) {
      // 非法百分号编码（如 /100%）不当作坏请求，按原样去匹配路由，匹配不上就是 404
      pathname = url.pathname;
    }
  } catch (err) {
    send(req, res, 400, '400 Bad Request');
    return;
  }

  // ---------------------- 前端配置：两个服务分别在哪 ----------------------
  // 页面用它显示当前访问地址，也用它知道数据服务开在哪个端口 ——
  // 所以数据服务换端口不需要改前端代码，改这里的环境变量即可。
  if (pathname === '/api/config') {
    sendJson(req, res, {
      host: HOST,
      port: Number(PORT),
      url: serverUrl(),
      data: { origin: DATA_ORIGIN }
    });
    return;
  }

  // ---------------------------- 前端资源 ----------------------------
  if (pathname === '/assets' || pathname.startsWith(ASSETS_PREFIX)) {
    sendAsset(req, res, pathname);
    return;
  }

  // ------------------------ 本地工具本体（tools/） ------------------------
  // 判据是「前缀之后还有没有东西」：/tools 与 /tools/ 都是页面，/tools/<项目名>/ 才是托管。
  // 两者共用前缀但不冲突 —— 一个精确匹配，一个要多一段。
  if (pathname.startsWith(TOOLS_PREFIX) && pathname.slice(TOOLS_PREFIX.length)) {
    sendProject(req, res, pathname);
    return;
  }

  // ------------------------------- 页面路由 -------------------------------
  // 去掉结尾斜杠，使 /tools/ 与 /tools 等价（根路径除外）
  const route = pathname.replace(/\/+$/, '') || '/';

  // 没有搜索词就不是一次搜索：/search、/search?q=、/search?q=%20 一律退回工具页。
  // 放在服务端是为了让手敲地址、旧链接也守同一条规则；前端提交空值时直接跳，不绕这一跳。
  if (route === '/search' && !(searchParams.get('q') || '').trim()) {
    send(req, res, 302, '', { Location: '/tools', 'Cache-Control': 'no-store' });
    return;
  }

  // 必须用 hasOwnProperty 判定：ROUTES 是普通对象，/constructor、/toString 这类路径会
  // 顺着原型链取到真值，直接当命中处理就会 500
  const entry = Object.prototype.hasOwnProperty.call(ROUTES, route) ? ROUTES[route] : null;
  if (entry) {
    sendFile(req, res, path.resolve(ROOT, entry.file));
    return;
  }

  // 其余一切地址：404（例如 /abc、/index.html、/favicon.ico、/catalog/*、/data-service/*）
  notFound(req, res, pathname);
});

/* --------------------------- 连接层的三个上限 ---------------------------
 * 本站只发 GET / HEAD，一次请求小到几十字节 —— 正常情形下毫秒级就收发完了。
 * 但 Node 的默认值是按「公网长连接服务」定的（收请求头 60 秒、收完整个请求 300 秒），
 * 对这里太宽：一个连上来却不发完请求的 socket，能白占着一个连接好几分钟。
 *
 * 收紧之后**只会误伤「真有请求正在慢慢地发」这种情形，而本站没有这种请求**：
 * 三个数字都留了足够的余量（本机取数实测个位数毫秒）。
 * 反过来说，不设的下场是：本地工具页里一个写坏的 fetch 就能把连接占住，
 * 表现是「服务在跑，但有的请求一直不回来」——这种最难查，因为它时有时无。
 */
server.headersTimeout = 10_000;    // 收完请求头的最长时间
server.requestTimeout = 20_000;    // 收完整个请求的最长时间
server.keepAliveTimeout = 5_000;   // 空闲长连接保持多久（浏览器下次来会重开，无感）

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换个端口再试，例如：PORT=8080 node server.js`);
  } else {
    console.error('服务启动失败：', err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`静态页服务  ${serverUrl()}`);
  console.log(`  首页      ${serverUrl()}/`);
  console.log(`  工具页    ${serverUrl()}/tools`);
  console.log(`  搜索结果  ${serverUrl()}/search?q=关键词`);
  console.log(`  本地工具  ${serverUrl()}/tools/<项目名>/   ← 对应 tools/ 下的一个目录`);
  console.log(`  数据服务  ${DATA_ORIGIN}   ← 页面从这里取工具数据，由 DATA_ORIGIN 决定`);
  console.log(`静态目录：${ROOT}`);
  console.log('提示：PORT=8080 node server.js 可临时更换端口（HOST / PORT 环境变量同样生效）。');
});

// 优雅退出，避免端口残留占用
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  console.log('\n已停止服务。');
  server.close(() => process.exit(0));
}));
