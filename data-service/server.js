/**
 * 数据服务 —— 只发数据，不托管任何页面。
 * ===========================================================================
 * 零依赖（除可选的 mysql2）。监听自己的端口，与静态页那个端口分开：
 * 以后换成 MySQL、搬到别的机器、或者中间加一层代理，改的都是这里，页面代码一行不动。
 *
 * 端点（全部 GET）：
 *   /api/tools?q=&tag=&page=&pageSize=   分页列表，服务端过滤
 *   /api/tags                            分类清单
 *   /api/hot?limit=6                     首页热门推荐
 *   /api/health                          存活与数据源自检
 *
 * 配置：
 *   DATA_HOST      默认 127.0.0.1
 *   DATA_PORT      默认 3001
 *   CORS_ORIGIN    逗号分隔的来源白名单；不设则发 *（本服务无 Cookie 无凭据，合规）
 *   DATA_SOURCE    json-dir（默认）/ json-file / js-file / mysql
 *   DATA_DIR       json-dir 的目录，默认 catalog
 *   DATA_FILE      json-file / js-file 的文件路径
 *   MYSQL_*        mysql 的连接配置
 *
 * 启动：node data-service/server.js      或      npm run start:data
 * ===========================================================================
 */

const http = require('http');
const { createDataSource, availableSources } = require('./core/resolve');
const { toPublic } = require('./core/normalize');
const {
  PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, PAGE_MAX, Q_MAX, TAG_MAX,
  HOT_LIMIT_DEFAULT, HOT_LIMIT_MAX
} = require('./core/contract');

const HOST = process.env.DATA_HOST || '127.0.0.1';
const PORT = process.env.DATA_PORT || 3001;
const STARTED_AT = Date.now();

// 数据源在启动时就建好：配置写错、mysql2 没装，都该在启动时当场报错，
// 而不是等第一个请求进来才 500。
let adapter;
try {
  adapter = createDataSource(process.env);
} catch (err) {
  console.error('数据服务启动失败：' + err.message);
  process.exit(1);
}

/* ------------------------------- 响应工具 ------------------------------- */

/**
 * CORS 头。不设 CORS_ORIGIN 时发 `*` —— 这不是「写死」：它不含任何主机名和端口，
 * 恰恰是「不写死」的表达。本服务无 Cookie、无凭据，规范上完全合法。
 * 设了就改成回显白名单里的 Origin，并加 Vary 以免被缓存串味。
 */
function corsHeaders(req) {
  const allowed = String(process.env.CORS_ORIGIN || '').trim();
  if (!allowed) return { 'Access-Control-Allow-Origin': '*' };

  const list = allowed.split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  if (origin && list.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return {};   // 不在名单里就不发头，让浏览器自己拦
}

function sendJson(req, res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, corsHeaders(req), extraHeaders || {}));
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendError(req, res, status, code, message) {
  sendJson(req, res, status, { error: { code, message } });
}

/* ------------------------------- 参数校验 ------------------------------- */

/** 参数非法直接 400，不静默兜底 —— 兜底会让「地址写错了」表现为「结果莫名其妙」 */
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'BAD_REQUEST';
  return err;
}

/** 空值（缺参数或 ?page=）当没传，取默认值 */
function readIntParam(params, name, def, min, max) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return n;
}

function readStrParam(params, name, max) {
  const raw = params.get(name);
  const s = (raw === null ? '' : raw).trim();
  if (s.length > max) throw badRequest(`${name} 最长 ${max} 个字符`);
  return s;
}

/* --------------------------------- 路由 --------------------------------- */

async function handle(req, res, pathname, params) {
  switch (pathname) {
    case '/api/tools': {
      const query = {
        q: readStrParam(params, 'q', Q_MAX),
        tag: readStrParam(params, 'tag', TAG_MAX),
        page: readIntParam(params, 'page', 1, 1, PAGE_MAX),
        pageSize: readIntParam(params, 'pageSize', PAGE_SIZE_DEFAULT, 1, PAGE_SIZE_MAX)
      };
      const result = await adapter.list(query);
      // 记录在这里离开本服务：统一收成契约字段（enabled 到此为止），适配器不必各自记得
      sendJson(req, res, 200, Object.assign({}, result, { items: result.items.map(toPublic) }));
      return;
    }

    case '/api/tags': {
      sendJson(req, res, 200, { tags: await adapter.tags() });
      return;
    }

    case '/api/hot': {
      const limit = readIntParam(params, 'limit', HOT_LIMIT_DEFAULT, 1, HOT_LIMIT_MAX);
      sendJson(req, res, 200, { items: (await adapter.hot(limit)).map(toPublic), limit });
      return;
    }

    case '/api/health': {
      // 顺带把数据源真的读一次：健康检查不碰数据就说不上是健康检查
      const probe = await adapter.list({ q: '', tag: '', page: 1, pageSize: 1 });
      sendJson(req, res, 200, {
        ok: true,
        source: adapter.name,
        describe: adapter.describe || null,
        count: probe.totalAll,
        uptimeMs: Date.now() - STARTED_AT
      });
      return;
    }

    default:
      sendError(req, res, 404, 'NOT_FOUND', `没有这个接口：${pathname}。可用：/api/tools、/api/tags、/api/hot、/api/health`);
  }
}

/* -------------------------------- 服务 -------------------------------- */

const server = http.createServer((req, res) => {
  // 预检兜底。前端刻意只发「简单请求」（GET、无自定义头、无凭据），本来不会触发预检，
  // 这个分支是为了别人手写请求时也别撞墙。
  if (req.method === 'OPTIONS') {
    res.writeHead(204, Object.assign({
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }, corsHeaders(req)));
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    sendError(req, res, 405, 'METHOD_NOT_ALLOWED', '只支持 GET / HEAD');
    return;
  }

  let pathname;
  let params;
  try {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    params = url.searchParams;
    pathname = url.pathname.replace(/\/+$/, '') || '/';
  } catch (err) {
    sendError(req, res, 400, 'BAD_REQUEST', '请求地址解析失败');
    return;
  }

  handle(req, res, pathname, params).catch(err => {
    if (res.headersSent) return;

    if (err.status === 400) {
      sendError(req, res, 400, 'BAD_REQUEST', err.message);
      return;
    }
    if (err.code === 'DATA_SOURCE_UNAVAILABLE') {
      // 「取不到数据」—— 前端据此显示失败态，且**不许显示任何数字**
      console.error('[数据源不可用] ' + err.message);
      sendError(req, res, 500, 'DATA_SOURCE_UNAVAILABLE', err.message);
      return;
    }
    console.error('[500] ' + (err.stack || err.message));
    sendError(req, res, 500, 'INTERNAL', '服务内部错误');
  });
});

/* --------------------------- 连接层的三个上限 ---------------------------
 * 这里只有 GET / HEAD，请求小、应答也小。Node 的默认值是按公网长连接服务定的
 * （收请求头 60 秒、收完整个请求 300 秒），对本站太宽 —— 一个连上来却不发完请求的
 * socket 能白占着连接好几分钟。
 *
 * 收紧**不会误伤正常请求**：本机取数实测个位数毫秒，下面三个数留了两个数量级余量。
 * 不设的代价则很隐蔽：连接被占住时，表现是「服务在跑，但有的请求一直不回来」，
 * 而这种错时有时无，最难查。
 *
 * 注意这和前端那个 5 秒超时是**两道独立的闸**：前端管「我不等了」，
 * 这里管「你别占着我的连接」。只设一道都不完整 —— 前端走了，连接还在。
 */
server.headersTimeout = 10_000;    // 收完请求头的最长时间
server.requestTimeout = 20_000;    // 收完整个请求的最长时间
server.keepAliveTimeout = 5_000;   // 空闲长连接保持多久（浏览器下次来会重开，无感）

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换个端口再试，例如：DATA_PORT=4001 node data-service/server.js`);
  } else {
    console.error('数据服务启动失败：' + err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`数据服务    http://${HOST}:${PORT}`);
  console.log(`  数据源    ${adapter.name}${adapter.describe ? '  →  ' + adapter.describe : ''}`);
  console.log(`  可选数据源 ${availableSources().join(' / ')}（用 DATA_SOURCE 切换）`);
  console.log(`  自检      http://${HOST}:${PORT}/api/health`);
});

/* 优雅退出：把连接池之类的东西交还掉 */
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  console.log('\n数据服务已停止。');
  const done = () => server.close(() => process.exit(0));
  if (typeof adapter.close === 'function') {
    Promise.resolve(adapter.close()).then(done, done);
  } else {
    done();
  }
}));
