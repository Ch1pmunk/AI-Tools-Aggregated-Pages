/* ===========================================================================
 * router.js —— 应用状态与路由
 * ---------------------------------------------------------------------------
 * 地址栏是状态的唯一真相来源：当前视图、搜索词、分类都写在地址里，
 * 刷新、分享、前进后退都能原样还原（见 buildUrl / applyUrlState）。
 *
 * 三个路径与页面一一对应；除这三个外，其余地址由 server.js 直接返回 404。
 * 站内跳转走 pushState，不刷新页面。
 * =========================================================================== */

import { $, showToast } from './ui.js';
import {
  renderHotTools, renderTagFilters, renderAllTools, renderSearchResults,
  allTags, tagsLoaded, loadTags, retryView
} from './views.js';

export const ROUTES = { home: '/', tools: '/tools', search: '/search' };

/**
 * 应用状态：当前视图（home | tools | search）/ 已提交的搜索词 / 选中的分类。
 * 这三个值都能从地址栏还原，不要在这里存任何别的东西 ——
 * 存了就会出现「刷新后不见了」的隐形状态。
 */
export const state = { view: 'home', q: '', tag: '' };

/* ------------------------------- 地址 ↔ 状态 ------------------------------- */

/** 去掉结尾斜杠的当前路径，/tools/ 与 /tools 视为同一页 */
export function currentPath() {
  const p = (location.pathname || '/').replace(/\/+$/, '');
  return p || '/';
}

/** 由地址栏解析出视图（没登记的路径在服务端已被 404 拦下，这里按首页兜底） */
function viewFromUrl() {
  const p = currentPath();
  if (p === ROUTES.tools) return 'tools';
  if (p === ROUTES.search) return 'search';
  return 'home';
}

/** 状态 → 地址。搜索词与分类都进地址栏，刷新、分享、后退都能还原 */
export function buildUrl(view) {
  const q = String(state.q || '').trim();
  const tag = String(state.tag || '').trim();

  if (view === 'search' && q) {
    const params = new URLSearchParams({ q });
    if (tag) params.set('tag', tag);
    return ROUTES.search + '?' + params.toString();
  }
  // 首页、工具页，以及「在搜索页但搜索词被清空」：后两者都落到工具页，
  // 与 server.js 对 /search 无 q 的 302 规则一致，只是省掉一次往返跳转
  if (view === 'tools' || view === 'search') {
    return tag ? ROUTES.tools + '?tag=' + encodeURIComponent(tag) : ROUTES.tools;
  }
  return ROUTES.home;
}

/** 同步地址栏；open=true 表示新增一条历史记录，false 表示原地替换 */
export function syncUrl(open) {
  if (location.protocol === 'file:') return;   // 直接以 file:// 打开时无法改写路径
  try {
    const url = buildUrl(state.view);
    if (open) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  } catch (err) { /* 不支持 History API 时忽略，页面仍可用 */ }
}

/* -------------------------------- 渲染外壳 -------------------------------- */

/** 只负责视图外观：显隐、导航选中态、标题。不等数据 —— 数据挂了页面结构依然完整 */
export function renderView() {
  const view = state.view;
  $('#view-home').classList.toggle('hidden', view !== 'home');
  $('#view-tools').classList.toggle('hidden', view !== 'tools');
  $('#view-search').classList.toggle('hidden', view !== 'search');

  // 导航选中态：黑底白字。搜索结果页属于工具列表的过滤视图，因此仍高亮「AI工具页」
  const navView = view === 'search' ? 'tools' : view;
  document.querySelectorAll('.nav-link').forEach(el => {
    const active = el.dataset.view === navView;
    el.classList.toggle('bg-ink', active);
    el.classList.toggle('text-white', active);
    el.classList.toggle('text-muted', !active);
  });

  const label = view === 'search' && state.q ? `搜索「${state.q}」`
    : view === 'tools' ? 'AI 工具页' : '首页';
  document.title = label + ' · AI 工具导航';
}

/** 统一重绘：分类条 + 当前视图外壳 + 当前视图的列表，全部由 state 推导 */
export function renderAll() {
  renderTagFilters(state.tag);
  renderView();
  // 只渲染当前视图那一份列表。每个列表现在都是一次真实的网络请求，
  // 顺手把看不见的那个也取一遍纯属浪费 —— 它本来就是 hidden 的，
  // 等真正切过去时再取（切过去必然经过 renderAll）。
  if (state.view === 'tools') renderAllTools(state.tag);
  if (state.view === 'search') renderSearchResults(state.q, state.tag);
}

/* -------------------------------- 状态变更 -------------------------------- */

/** 站内跳转：改状态 → 改地址 → 重绘 */
export function navigateTo(view, options) {
  const opts = options || {};
  state.view = (view === 'search' || view === 'tools') ? view : 'home';
  syncUrl(opts.open !== false);
  renderAll();
}

/** 由地址栏还原全部状态并重绘（初次加载 / 前进后退） */
export function applyUrlState() {
  const params = new URLSearchParams(location.search);
  state.view = viewFromUrl();
  state.q = state.view === 'search' ? (params.get('q') || '').trim() : '';
  state.tag = (params.get('tag') || '').trim();

  // 分类清单没取到时**不做**这个校验。门闩是必须的：
  // 数据服务一挂，清单就是空的，深链 /tools?tag=办公 会被静默清成「全部」，
  // 页面和地址栏就对不上了 —— 那是在拿「没数据」冒充「没这个分类」。
  // 清单到手后由 loadTagsAndSync() 补做这次校验。
  if (state.tag && tagsLoaded() && !allTags().includes(state.tag)) state.tag = '';

  $('#searchInput').value = state.q;
  renderAll();
}

/**
 * 取分类清单并重绘分类条。
 * 清单到手后才谈得上「地址里这个分类存不存在」，所以校验放在这里补做一次；
 * 确实不存在就地改成「全部」，并用 replaceState 而不是 pushState ——
 * 自动纠正不是用户的一次操作，不该在历史里多留一条。
 */
export async function loadTagsAndSync() {
  const ok = await loadTags();
  if (!ok) return false;

  renderTagFilters(state.tag);

  if (state.tag && !allTags().includes(state.tag)) {
    state.tag = '';
    syncUrl(false);
    renderAll();
  }
  return true;
}

/** 点重试：分类清单可能也没取到，连同当前视图的列表一起重来 */
export async function retryCurrent() {
  await loadTagsAndSync();
  await retryView(state.view);
}

/**
 * 提交搜索：回车或点放大镜时调用（打字过程不触发）。
 * 输入为空则不算一次搜索，直接去工具页。
 */
export function submitSearch() {
  const kw = $('#searchInput').value.trim();
  state.q = kw;
  if (!kw) { state.tag = ''; navigateTo('tools', { open: true }); return; }
  navigateTo('search', { open: true });
}

/** 点分类胶囊：只改分类，地址同步过去（新增一条历史，便于用后退撤销这次筛选） */
export function selectTag(tag) {
  state.tag = tag;
  syncUrl(true);
  renderAll();
}

/**
 * 点击卡片：有 url 则新窗口打开，为空则提示「即将上线」。
 * 指向本地工具本体、但本体还没放进 tools/ 的，只给提示，不开窗口
 * （见下 localMissing）。
 *
 * url 与 name 由调用方从卡片的 data-tool-url / data-tool-name 上读出来传进来，
 * 同样，localMissing 也是从卡片上读的（views.js 在渲染后探好了写在 data-tool-local 上），
 * 不在内存里维护一份 id→工具 的索引（那份索引要在重绘/切换/翻页时想清楚何时清何时累积，
 * 全是白送的状态）。
 *
 * **这里必须是同步的**：window.open() 要落在用户手势的同步调用栈里，
 * 一旦前面 await 过什么，浏览器就按弹窗拦掉。这也是「本体在不在」要提前探好的原因 ——
 * 不能在点击那一刻才去问服务端。
 *
 * @param {string} url
 * @param {string} name
 * @param {boolean} localMissing  卡片上已探明「本地副本不在」（data-tool-local="missing"）
 */
export function openTool(url, name, localMissing) {
  const target = String(url || '').trim();

  if (!target) {
    showToast(`「${name}」即将上线`);
    return;
  }

  // 明知打不开就别开：新窗口里是一张「还没有本地副本」的说明页，
  // 用户还得自己关掉它。先在当前页说清楚。
  //
  // 注意只有**探明确实没有**才走这条路；探测超时/失败（unknown）一切照旧 ——
  // 「没探到」不等于「没有」，那种情况让服务端去给结论。
  if (localMissing) {
    showToast(`「${name}」还没有本地副本`);
    return;
  }

  window.open(target, '_blank', 'noopener,noreferrer');
}
