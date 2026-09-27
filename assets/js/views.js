/* ===========================================================================
 * views.js —— 三个视图各自的渲染逻辑
 * ---------------------------------------------------------------------------
 * 只负责「把数据变成页面上的东西」：首页热门推荐、工具页列表、搜索结果页列表。
 * 不碰地址栏、不碰事件绑定（那些在 router.js / main.js），
 * 需要的状态一律由参数传进来，不直接读全局 state —— 这样它不依赖 router，
 * 两者不会绕成循环 import。
 *
 * 【一条贯穿全文件的规矩】「0 条」和「不知道有几条」必须能分辨：
 *   · 成功取到数据、只是没有 → 空状态块（「暂无工具收录」）
 *   · 压根取不到数据         → 失败态（「未能读取工具数据。」+ 重试），且**一个数字都不许出**
 * 所以每个计数元素都是先清空、拿到数据才写。见 Readme 第十二节。
 * =========================================================================== */

import {
  $, esc, cardHtml, placeholderCardHtml, localMissingPillHtml,
  emptyStateHtml, failureStateHtml, pillButton, showToast, TIMEOUT_TEXT
} from './ui.js';
import { createBatchLoader, PAGE_SIZE } from './pager.js';
import { fetchTools, fetchTags, fetchHot, probeLocalProject, isSitePath, isTimeout } from './api.js';

/** 首页热门推荐最多展示的卡片位数（3 列 × 2 行）。槽位数是版面事实，不是数据事实 */
export const HOT_SLOTS = 6;

/* -------------------------- 本地项目资源探查 -------------------------- */

/**
 * 探一遍卡片里那些指向本地工具的，把「本体在不在」写到卡片的 data-tool-local 上。
 *
 * 为什么不在点击时才去问：点击要同步开窗（见 router.js 的 openTool），
 * 中间插一个 await 就会被浏览器当弹窗拦掉。所以反过来 —— 渲染完就探好、记在卡片上，
 * 点击时同步读出来。放在这里（而不是 pager.js）是因为它只跟「渲染好的卡片」有关，
 * 分批加载那层不需要知道本地工具这回事。
 *
 * 结果分四种，**unknown 和 missing 必须分开**（同「0 条 vs 不知道有几条」一条道理）：
 *   ok / na   正常打开
 *   missing   探到 404 → 卡片贴「本地副本未就位」，点了只给提示，不开一个注定是错误页的新窗口
 *   unknown   超时 / 5xx / 连不上 → **什么都不标**，点击照旧打开，由服务端给出说明页
 *
 * 不能把「没探到」当成「没有」：那是把不确定说成事实。
 */
export function probeLocalCards(grid) {
  if (!grid) return;

  // 已探过的卡片自带 data-tool-local，不会再被选中 —— 所以反复调用是安全的
  grid.querySelectorAll('[data-tool-url]:not([data-tool-local])').forEach(async (card) => {
    const url = card.dataset.toolUrl;

    if (!isSitePath(url)) { card.dataset.toolLocal = 'na'; return; }
    card.dataset.toolLocal = 'pending';   // 先占位，免得同一张卡被探两次

    const found = await probeLocalProject(url);

    if (found === true) { card.dataset.toolLocal = 'ok'; return; }

    if (found === false) {
      card.dataset.toolLocal = 'missing';
      const box = card.querySelector('[data-tool-status]');
      if (box) box.innerHTML = localMissingPillHtml();
      return;
    }

    card.dataset.toolLocal = 'unknown';
  });
}

/**
 * 取数失败时统一收尾：清掉计数（数字只在拿到数据后才许出现），
 * 超时再额外弹一条提示 —— 超时和「连不上」要查的东西不一样，
 * 状态行上那句话说明不了它是哪一种，弹一下更直接。
 */
function handleFetchError(err) {
  if (isTimeout(err)) showToast(TIMEOUT_TEXT);
}

/* ------------------------------ 分类清单 ------------------------------ */

/**
 * 分类清单只在页面加载时取一次，之后缓存在这里。
 * null = 还没成功取到（≠ 空数组）。这个区分很要紧：数据服务挂掉时清单是 null，
 * 「一个分类都没有」是 []，前者不该被当成后者去处理（见 router.js 的 tagsLoaded 门闩）。
 */
let tagsCache = null;

export function tagsLoaded() { return tagsCache !== null; }
export function allTags() { return tagsCache || []; }

/** 取分类清单。失败返回 false 并把缓存清空，好让下次重试真的重来一遍 */
export async function loadTags() {
  try {
    tagsCache = await fetchTags();
    return true;
  } catch (err) {
    tagsCache = null;
    return false;
  }
}

/** 分类筛选条：工具页与搜索结果页共用同一份数据、同一个选中态 */
export function renderTagFilters(activeTag) {
  const boxes = ['#tagFilter', '#searchTagFilter'].map($).filter(Boolean);

  // 清单没取到、或者一件工具都没有 —— 整条不渲染。
  // 「全部」那个胶囊的内容也是数据派生的，单留它一个等于宣称「分类就一种」。
  if (!tagsLoaded() || allTags().length === 0) {
    boxes.forEach(box => { box.innerHTML = ''; });
    return;
  }

  const html =
    `<span class="text-[11px] font-medium uppercase tracking-[0.24em] text-muted mr-1">分类</span>` +
    pillButton('全部', '', activeTag) +
    allTags().map(tag => pillButton(tag, tag, activeTag)).join('');

  boxes.forEach(box => { box.innerHTML = html; });
}

/* --------------------------- 渲染：首页热门推荐 --------------------------- */

/**
 * 首页热门推荐。
 * 取哪些由服务端定（hot 优先，不足的用其余可展示工具补足）；取几个由页面定（槽位数）。
 * 不足的槽位渲染虚线占位卡 —— 但**只有在成功拿到数据之后**才谈得上「不足」。
 */
export async function renderHotTools() {
  const grid = $('#hotGrid');
  const countEl = $('#hotCount');

  countEl.textContent = '';   // 先清空：数字只在拿到数据之后才允许出现

  try {
    const picked = (await fetchHot(HOT_SLOTS)).slice(0, HOT_SLOTS);

    if (picked.length === 0) {
      // 成功，但确实一条都没有 —— 这是「0 条」，可以明说
      grid.innerHTML = emptyStateHtml('暂无工具收录');
      return;
    }

    countEl.textContent = `共 ${picked.length} 个`;
    const placeholders = HOT_SLOTS - picked.length;
    grid.innerHTML =
      picked.map(cardHtml).join('') +
      Array.from({ length: placeholders }, (_, i) => placeholderCardHtml(picked.length + i + 1)).join('');

    probeLocalCards(grid);
  } catch (err) {
    // 取不到数据：一个数字都不写，也**不画任何卡片，包括虚线占位卡**。
    // 占位卡不只是装饰，它等于宣称「本站的工具不足 6 个」——那是在编造事实。
    // 失败态只能是失败态，不能拿空状态或占位卡去顶。
    countEl.textContent = '';
    grid.innerHTML = failureStateHtml(err);
    handleFetchError(err);
  }
}

/* ------------------------------ 工具页列表 ------------------------------ */

/** 当前工具页正在用的筛选分类。fetchPage 是个闭包，取数时才读它 */
let toolsTag = '';

const toolsPager = createBatchLoader({
  grid: $('#toolGrid'),
  status: $('#toolMore'),
  cardOf: cardHtml,
  fetchPage: (page) => fetchTools({ q: '', tag: toolsTag, page, pageSize: PAGE_SIZE }),
  onMeta: ({ total, totalAll }) => {
    // 按「是否真的在筛选」判断文案：筛完恰好全中时也该显示筛选态，否则看不出过滤生效。
    // 数字一律来自服务端：本地拿「已加载的那几页」去数，分页之下必错。
    $('#toolCount').textContent = toolsTag
      ? `筛选出 ${total} / ${totalAll} 个工具`
      : `共 ${totalAll} 个工具`;

    if (total === 0) {
      $('#toolGrid').innerHTML = emptyStateHtml('没有匹配的工具', '点「全部」查看所有工具。');
    }

    // 卡片刚插进 DOM，顺手探一遍本地工具本体在不在（结果写在卡片上，点击时同步读）
    probeLocalCards($('#toolGrid'));
  },
  onError: (err) => {
    $('#toolCount').textContent = '';
    handleFetchError(err);
  }
});

/** AI 工具页：只按分类过滤（搜索已移到搜索结果页） */
export function renderAllTools(tag) {
  const next = tag || '';

  // 同一筛选条件重复渲染时什么都不做：DOM 还在（视图只是被隐藏），
  // 重来一次会白白重取第 1 页，还会把用户滚了半天的位置打回顶部
  if (next === toolsTag && toolsPager.hasLoaded()) return;

  toolsTag = next;
  $('#toolCount').textContent = '';   // 先清掉上一次的数字，免得它冒充本次结果
  toolsPager.reload();
}

/* ----------------------------- 搜索结果页列表 ----------------------------- */

let searchQ = '';
let searchTag = '';

const searchPager = createBatchLoader({
  grid: $('#searchGrid'),
  status: $('#searchMore'),
  cardOf: cardHtml,
  fetchPage: (page) => fetchTools({ q: searchQ, tag: searchTag, page, pageSize: PAGE_SIZE }),
  onMeta: ({ total }) => {
    $('#searchCount').innerHTML =
      `搜索到「${esc(searchQ)}」相关工具共 <span class="text-ink font-medium">${total}</span> 个`;
    probeLocalCards($('#searchGrid'));
  },
  onError: (err) => {
    $('#searchCount').textContent = '';
    handleFetchError(err);
  }
});

/**
 * 搜索结果页：主体与工具页一致，另加一行居中小字说明命中数量。
 * 结果 = 搜索词 + 分类筛选叠加；命中 0 个时不出任何卡片，也不给空状态块
 * （那行小字已经说了「共 0 个」，再叠一个空状态就成了两句话讲同一件事）。
 * 注意这和「取不到数据」是两回事：那种情况下连那行小字都不出现。
 */
export function renderSearchResults(q, tag) {
  const nq = q || '';
  const nt = tag || '';

  if (!nq) {                    // 不在搜索页时清空，避免留下上一次的残影
    searchPager.clear();
    $('#searchCount').textContent = '';
    return;
  }
  if (nq === searchQ && nt === searchTag && searchPager.hasLoaded()) return;

  searchQ = nq;
  searchTag = nt;
  $('#searchCount').textContent = '';
  searchPager.reload();
}

/* ------------------------------- 重试分发 ------------------------------- */

/**
 * 点重试：把当前视图重新取一遍。
 * 首页没有状态行，用的是虚线框里那个按钮，所以走 renderHotTools 这条老路。
 */
export async function retryView(view) {
  if (view === 'tools') { toolsPager.retry(); return; }
  if (view === 'search') { searchPager.retry(); return; }
  await renderHotTools();
}
