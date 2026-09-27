/* ===========================================================================
 * api.js —— 页面与后端之间的唯一通道
 * ---------------------------------------------------------------------------
 * 两件事：问出「数据服务开在哪」，然后去那儿取数据。
 * 除了这个文件，别处不许直接 fetch —— 否则地址解析、超时、错误归一化会各写一份。
 *
 * 【唯一的例外，已登记】index.html 里的 Tailwind CDN（外加字体那两个 link）不在这里，
 * 因为样式引擎没法走数据通道 —— 它是一句 <script src>，不是我们能包的 fetch。
 * 例外允许存在，但**必须自带失败对策**：那个脚本挂了页面会变成一篇没排版的纯文字，
 * 所以 index.html 里备了一句能看懂的中文提示（且用内联样式，不然提示自己也看不见）。
 * 再往页面里加任何外部资源（图标库、统计脚本…）时，先回 docs/principles.md 第一条登记，
 * 再给它补失败对策 —— 不许只加一句"反正它不会挂"。
 *
 * 【不写死地址】数据服务地址按四级优先级解析，见 resolveDataOrigin()：
 *   1. <meta name="data-origin"> —— 部署到别处时改 HTML 一行
 *   2. 本服务的 /api/config      —— 默认路径，端口由服务端环境变量决定
 *   3. location.origin           —— 数据服务与页面同源（反向代理）时自动正确
 *   4. 都没有 → 数据不可用
 * 所以「换端口」在服务端改一个环境变量就够了，前端一行不动。
 * =========================================================================== */

/** 静态服务器的配置接口。相对路径：永远问「当前这个站」，不写死主机端口 */
const CONFIG_URL = '/api/config';

/**
 * 请求超时（毫秒）。
 * 服务被关掉是 ECONNREFUSED，秒失败；但服务**卡住**不会 —— 没有超时，
 * 页面就永远停在「正在加载工具……」上，既不报错也没有重试入口。
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * 探测本地项目资源是否就位的超时（毫秒），比取数短。
 * 探测只是给卡片加个提示，是锦上添花；不值得让它挂 5 秒。
 */
const PROBE_TIMEOUT_MS = 2500;

/* ------------------------------ 错误归一化 ------------------------------ */

/**
 * 「取不到数据」的唯一错误类型。调用方只需要判断这一个，
 * 不用去分辨是连不上、超时、还是响应格式不对 —— 对页面来说都是同一件事：没有数据。
 *
 * `err.timeout` 是唯一被单独标出来的情形：它和「连不上」要分开说，
 * 因为**要查的东西不一样** —— 连不上是「服务没起来」，超时是「服务起来了但不应答」。
 * 混成一句话，排障时就没有线索了。
 */
export function dataUnavailable(message, cause, options) {
  const err = new Error(message);
  err.code = 'DATA_UNAVAILABLE';
  if (cause) err.cause = cause;
  if (options && options.timeout) err.timeout = true;
  return err;
}

export function isDataUnavailable(err) {
  return Boolean(err && err.code === 'DATA_UNAVAILABLE');
}

/** 这次失败是不是超时 */
export function isTimeout(err) {
  return Boolean(err && err.timeout);
}

/**
 * 带超时的 fetch —— **本文件里所有出站请求都必须走它**。
 *
 * 超时一到，AbortSignal 会把请求掐掉：**对面后来才回的那份响应根本不会到达**，
 * 也就谈不上「迟到的结果覆盖了新结果」。这是「丢掉超时的返回」的落地方式 ——
 * 不是靠调用方记得去判断，而是让它收不到。
 */
function fetchWithTimeout(url, options) {
  return fetch(url, Object.assign({ cache: 'no-store' }, options, {
    signal: AbortSignal.timeout(options && options.timeoutMs ? options.timeoutMs : REQUEST_TIMEOUT_MS)
  }));
}

/** 把 fetch 抛出的异常翻成我们的错误类型，并认出「超时」这一种 */
function toRequestError(err, describe, timeoutMs) {
  const timedOut = Boolean(err && (err.name === 'TimeoutError' || err.name === 'AbortError'));
  return dataUnavailable(
    timedOut
      ? `请求超时（${timeoutMs}ms）：${describe}`
      : `连不上服务：${describe}`,
    err,
    { timeout: timedOut }
  );
}

/* ---------------------------- 数据服务地址解析 ---------------------------- */

/** 去掉结尾斜杠，方便后面拼路径 */
const trimSlash = (s) => String(s).trim().replace(/\/+$/, '');

async function resolveDataOrigin() {
  // 直接以 file:// 打开时既没有后端也没有同源，发请求只会得到一堆看不懂的失败
  if (location.protocol === 'file:') {
    throw dataUnavailable('页面是以 file:// 直接打开的，没有服务端可连');
  }

  // 1. 页面里显式指定
  const meta = document.querySelector('meta[name="data-origin"]');
  const explicit = meta && meta.getAttribute('content');
  if (explicit && explicit.trim()) return trimSlash(explicit);

  // 2. 问本服务的 /api/config（默认路径）。拿不到就往下走，不当作错误
  const cfg = await fetchConfig();
  const fromCfg = cfg && cfg.data && cfg.data.origin;
  if (fromCfg && String(fromCfg).trim()) return trimSlash(fromCfg);

  // 3. 与页面同源：数据服务挂在同一个域名下时（反向代理）自动正确，且完全没有跨域
  if (location.origin && location.origin !== 'null') return trimSlash(location.origin);

  throw dataUnavailable('无法确定数据服务地址');
}

/**
 * 只解析一次，之后复用。
 * 失败时把缓存清掉 —— 否则第一次解析失败（比如数据服务还没起来）之后，
 * 点重试也永远用不上新地址。缓存必须能失败重来，重试才有意义。
 */
let originPromise = null;
function getDataOrigin() {
  if (!originPromise) {
    originPromise = resolveDataOrigin().catch(err => {
      originPromise = null;
      throw err;
    });
  }
  return originPromise;
}

/* -------------------------------- 请求 -------------------------------- */

/**
 * 发一个 GET 并解析 JSON。
 *
 * 刻意保持「简单请求」：只用 GET、不带自定义头、不带凭据。
 * 这样浏览器不会发 CORS 预检 —— 数据服务少一次往返，也少一处可能配错的地方。
 * **要加请求头或改凭据之前，先去确认数据服务的 CORS 配置**（见 docs/data-contract.md）。
 */
async function getJson(path, params) {
  const origin = await getDataOrigin();
  const url = new URL(path, origin + '/');
  Object.entries(params || {}).forEach(([k, v]) => {
    // 空值不发：让服务端用它自己的默认值，别用客户端的猜测覆盖它
    if (v !== '' && v !== null && v !== undefined) url.searchParams.set(k, v);
  });

  let res;
  try {
    res = await fetchWithTimeout(url.toString(), { method: 'GET' });
  } catch (err) {
    throw toRequestError(err, `${url.pathname}（${origin}）`, REQUEST_TIMEOUT_MS);
  }

  if (!res.ok) {
    // 服务端已经把原因写成人话了（见 data-service/server.js 的错误体），能读出来就用它
    let detail = '';
    try {
      const body = await res.json();
      detail = (body && body.error && body.error.message) || '';
    } catch (err) { /* 响应体不是 JSON，忽略 */ }
    throw dataUnavailable(detail || `数据服务返回 ${res.status}`);
  }

  try {
    return await res.json();
  } catch (err) {
    // 能回 200 但回的不是 JSON，说明连上的根本不是我们的数据服务
    throw dataUnavailable('数据服务返回的内容不是 JSON', err);
  }
}

/** 校验分页响应的形状。形状不对就当作不可用 —— 那意味着对面不是我们的数据服务 */
function checkPage(page) {
  if (!page || !Array.isArray(page.items)) throw dataUnavailable('数据服务返回的分页结构不对');
  return page;
}

/* ------------------------------- 对外的接口 ------------------------------- */

/** 真正去问一次。外面那层只管「问几次」 */
async function requestConfig() {
  const res = await fetchWithTimeout(CONFIG_URL, { method: 'GET' });
  if (!res.ok) return null;
  const cfg = await res.json();
  return cfg && typeof cfg === 'object' ? cfg : null;
}

/**
 * 读取服务端配置（页脚地址 + 数据服务地址）。拿不到返回 null，不抛错。
 *
 * **这个请求也必须带超时**，虽然它「拿不到就不管了」：它是解析数据服务地址的第一步，
 * 而静态服务一旦卡住（不是关掉，是卡住），没有超时的话 resolveDataOrigin 永远不返回，
 * 页面就停在「正在加载工具……」上 —— 既不报错，也不长重试按钮。这正是超时要防的那种情形。
 *
 * 【为什么要缓存】页面里有两个地方要问「数据服务开在哪」：页脚（main.js 的
 * loadServerAddress）和取数前的地址解析（resolveDataOrigin）。它们在 init 里几乎同时发起，
 * 而请求带的是 `cache: 'no-store'`，浏览器不会替我们把这两次合并掉 ——
 * 所以一次页面加载会**实打实发两遍** `GET /api/config`。这是量出来的，不是猜的。
 *
 * 对策两层，缺一不可：
 *   · **在途合并**：同时发起的调用共用同一个 promise，只出一趟网络
 *   · **成功缓存**：数据服务地址在一次会话里不会变，问到了就一直用
 *
 * 失败**不留缓存**：静态服务当时没起来、后来起来了，点重试必须能真的重问一遍 ——
 * 把 null 缓存下来，就等于把「那一刻没问到」永久钉死，重试按钮会变成摆设。
 */
let configPromise = null;   // 在途的那一次（同时来的调用共用它）
let configValue = null;     // 已问到的结果，之后一直复用

export async function fetchConfig() {
  // file:// 下没有服务端，连试都不必试 —— 页面这时本来就该是「数据不可用 + 页脚不显示地址」
  if (location.protocol === 'file:') return null;
  if (configValue) return configValue;
  if (!configPromise) {
    configPromise = requestConfig()
      .catch(() => null)                     // 拿不到不是错误，由调用方决定怎么办
      .finally(() => { configPromise = null; });
  }
  const cfg = await configPromise;
  if (cfg) configValue = cfg;
  return cfg;
}

/* -------------------------- 本地项目资源探查 -------------------------- */

/** 是不是站内地址（本地部署的工具本体就住在这里）。外链一律不探 */
export function isSitePath(url) {
  const s = String(url || '').trim();
  return s.startsWith('/') && !s.startsWith('//');
}

/**
 * 探一下这个本地工具的项目文件在不在。
 *
 * 为什么要在**点击之前**探：卡片点击必须同步开窗（见 router.js 的 openTool），
 * 所以不能在点击那一刻去问服务端 —— 问完再开窗会被浏览器当弹窗拦掉。
 * 那就反过来：**渲染完之后**挨个探一次，把结果写在卡片的 data-* 上，
 * 点击时同步读出来即可。
 *
 * 三种返回值，**第三种最要紧**：
 *   true  在          → 正常外链行为，点开就打开
 *   false 不在（404）  → 卡片标出来，点了只给提示，不开一个注定是错误页的新窗口
 *   null  不知道      → 超时、网络错、5xx。**绝不当成「不在」**
 *
 * null 不能当成 false，理由和「0 条 vs 不知道有几条」是同一条：
 * 把「没探到」说成「没有」，就是在把不确定说成事实。宁可让用户点开看到服务端的说明页。
 */
export async function probeLocalProject(url) {
  if (!isSitePath(url)) return null;

  let res;
  try {
    res = await fetchWithTimeout(new URL(url, location.origin).toString(), {
      method: 'HEAD',
      timeoutMs: PROBE_TIMEOUT_MS
    });
  } catch (err) {
    return null;   // 超时 / 连不上 → 不知道。响应本身已被 abort 丢掉，不会有迟到的结果落进来
  }

  if (res.ok) return true;
  if (res.status === 404) return false;
  return null;     // 5xx 之类：服务在，但它答不上来 → 仍然算不知道
}

/**
 * 分页取工具。筛选与分页**全部在服务端做** —— 客户端不许多算一遍，
 * 否则「已加载的那一页」会被当成全部，计数必错。
 * @returns {Promise<{items:object[], page:number, pageSize:number, total:number, totalAll:number, hasMore:boolean}>}
 */
export async function fetchTools({ q = '', tag = '', page = 1, pageSize }) {
  return checkPage(await getJson('/api/tools', { q, tag, page, pageSize }));
}

/** 分类清单。顺序由服务端定（用得多的在前），前端不重排 */
export async function fetchTags() {
  const data = await getJson('/api/tags');
  if (!data || !Array.isArray(data.tags)) throw dataUnavailable('数据服务返回的分类结构不对');
  return data.tags;
}

/** 首页热门推荐。条数由客户端给（槽位数是版面事实），取哪些由服务端定 */
export async function fetchHot(limit) {
  const data = await getJson('/api/hot', { limit });
  if (!data || !Array.isArray(data.items)) throw dataUnavailable('数据服务返回的热门结构不对');
  return data.items;
}
