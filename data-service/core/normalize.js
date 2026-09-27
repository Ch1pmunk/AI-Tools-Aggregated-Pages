/**
 * 语义层 —— 归一化、校验、过滤、排序、匹配、分页的**唯一出处**。
 * ---------------------------------------------------------------------------
 * 适配器只管「怎么把原始记录读出来」，语义一律走这里。适配器里不许再实现一份，
 * 否则 json 版和 mysql 版迟早会不一致，而这种不一致极难发现。
 *
 * 唯一允许分叉的是 mysql 适配器：它把过滤/排序/分页下推成 SQL（否则要把整表读进内存，
 * 那就白用数据库了）。但它仍然必须走这里的 normalizeTool，而且必须拿
 * memory-adapter 对拍 —— 对拍用例见 docs/adapters.md。
 * ---------------------------------------------------------------------------
 */

const { ORDER_DEFAULT, LIKES_DEFAULT } = require('./contract');

/**
 * URL 白名单：只收 http / https，或**站内单个 `/` 开头的相对地址**，其余一律归一化成空串。
 *
 * 数据还在代码里的时候，人写什么就是什么；数据一旦离开代码（文件、数据库、以后别人
 * 提交的记录），`javascript:alert(1)` 这种值就会顺着卡片点击流进 window.open —— 那是 XSS。
 * 这道防线不设，就得指望每个数据源自己干净。
 *
 * 为什么放行站内相对地址：本地部署的工具本体（解压后的开源项目）就住在本站的
 * `/tools/<项目名>/` 下，卡片要能直接点进去。这类地址不出站，仍然在白名单哲学之内。
 *
 * 两个必须挡掉的写法：
 *   `//evil.com/x`  协议相对地址 —— 浏览器会当成 https://evil.com/x，是**外站**
 *   `ppt/index.html` 不以 / 开头 —— 会相对「当前页面所在目录」解析，在 /search 下就变成 /ppt/，
 *                    地址随页面漂移，是控制不了的
 */
function safeUrl(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return '';
  if (s.startsWith('/')) return s.startsWith('//') ? '' : s;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : '';
  } catch (err) {
    return '';   // 乱七八糟的串，一律当没有链接
  }
}

/**
 * 点赞数：非负整数。
 * 负数、NaN、`"12"` 这类字符串、null 一律归 0 —— 点赞数没有负的，
 * 而排序键里混进 NaN 会让整个 sort 的次序变成未定义行为（比较函数永远返回 NaN）。
 */
function toLikes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return LIKES_DEFAULT;
  return Math.floor(n);
}

/** 标签：去空、去重、保序 */
function toTags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const tag = typeof item === 'string' ? item.trim() : '';
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * 归一化一条工具记录；返回 null 表示这条不可用（缺 id 或缺 name）。
 * 调用方负责丢弃它并打日志 —— **单条记录坏掉不能升级成整个请求失败**。
 */
function normalizeTool(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !name) return null;

  const order = Number(raw.order);

  return {
    id,
    name,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    tags: toTags(raw.tags),
    icon: typeof raw.icon === 'string' ? raw.icon.trim() : '',
    url: safeUrl(raw.url),
    // enabled 缺省为 true：没写这个字段就是「要展示」
    enabled: raw.enabled !== false,
    likes: toLikes(raw.likes),
    order: Number.isFinite(order) ? order : ORDER_DEFAULT
  };
}

/**
 * 批量归一化：丢弃坏记录与重复 id，并通过 onDrop(raw, reason) 把原因交出去。
 * 打日志的事由调用方做（要按文件去重，不能每个请求刷一屏）。
 */
function normalizeAll(records, onDrop) {
  const out = [];
  const seen = new Set();
  for (const raw of records) {
    const tool = normalizeTool(raw);
    if (!tool) {
      if (onDrop) onDrop(raw, '缺少 id 或 name，或不是对象');
      continue;
    }
    if (seen.has(tool.id)) {
      if (onDrop) onDrop(raw, 'id 重复：' + tool.id);
      continue;
    }
    seen.add(tool.id);
    out.push(tool);
  }
  return out;
}

/**
 * 确定性排序：order 升序，同 order 按 id 升序。
 * 分页要求全序关系 —— 只要有两条记录比较结果不稳定，翻页就可能重复或漏掉。
 */
function compareTools(a, b) {
  if (a.order !== b.order) return a.order - b.order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 热门排序：点赞数降序，同点赞数回到 compareTools（order 升序、id 升序）。
 *
 * 必须显式写次级键，不能只按 likes 排：点赞数会有大量并列（尤其是清一色的 0），
 * 而 sort 对并列项的次序不保证稳定，同一批数据两次请求可能给出不同的 6 个。
 * 和分页同理 —— 排不出全序，结果就不确定。
 */
function compareHot(a, b) {
  if (a.likes !== b.likes) return b.likes - a.likes;
  return compareTools(a, b);
}

/**
 * 关键词匹配规则（**语义基准**，mysql 版必须向它对拍）：
 *   haystack = [name, description, ...tags].join(' ').toLowerCase()
 *   命中 = haystack.includes(q)
 *
 * 注意它是「拼成一个串后做包含匹配」，不是「逐个字段分别匹配」—— 两者不等价：
 * 拼串能让跨字段的巧合命中（比如 name 结尾接 description 开头），逐字段不行。
 * mysql 版用 CONCAT_WS 拼成一个串再 LIKE，就是为了对齐这一点。
 */
function matchesKeyword(tool, q) {
  if (!q) return true;
  const haystack = [tool.name, tool.description, ...tool.tags].join(' ').toLowerCase();
  return haystack.includes(String(q).toLowerCase());
}

/**
 * 按 q / tag 过滤。**输入必须是已排序的**（排序在构造数据源时做一次就够，
 * 不必每个请求重排）。q 传进来时只需 trim 过 —— 大小写在这里统一处理，
 * 免得大小写规则散到调用方去。
 */
function applyFilters(tools, { q, tag }) {
  let list = tools;
  if (tag) list = list.filter(t => t.tags.includes(tag));
  if (q) list = list.filter(t => matchesKeyword(t, q));
  return list;
}

/**
 * 分页切片。hasMore 由这里算出来交给前端，前端**不许**用 items.length < pageSize 推导 ——
 * 将来服务端要是加个「最后一页补齐」之类的逻辑，那个推导当场就错。
 */
function paginate(list, page, pageSize) {
  const start = (page - 1) * pageSize;
  return {
    items: list.slice(start, start + pageSize),
    page,
    pageSize,
    total: list.length,
    hasMore: page * pageSize < list.length
  };
}

/**
 * 出站投影：记录离开本服务前，把字段收成契约里写明的那几个。
 *
 * 两件事一次办完：
 *   1. **enabled 不出网**。它是「要不要展示」的判断依据，服务端已经用它筛过一遍了，
 *      前端既不该看见它，更不该拿它再过滤一次 —— 那就是同一套语义有两份实现，
 *      而其中一份还没人测。契约里写明「由服务端过滤掉，不会发给前端」，就得真的不发。
 *   2. 字段是**白名单**（和 ROUTES、MIME、URL 协议一样的做法）：以后给记录加内部字段
 *      （缓存键、文件路径、来源标记之类），不会因为忘了排除而顺带发出去。
 */
function toPublic(tool) {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    tags: tool.tags,
    icon: tool.icon,
    url: tool.url,
    likes: tool.likes,
    order: tool.order
  };
}

module.exports = {
  safeUrl,
  toTags,
  toLikes,
  normalizeTool,
  normalizeAll,
  compareTools,
  compareHot,
  matchesKeyword,
  applyFilters,
  paginate,
  toPublic
};
