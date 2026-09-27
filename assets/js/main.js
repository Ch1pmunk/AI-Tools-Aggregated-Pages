/* ===========================================================================
 * main.js —— 唯一入口
 * ---------------------------------------------------------------------------
 * 干两件事：绑事件、走第一次渲染。业务逻辑都在别的模块里，这里只做接线。
 * 改动页面逻辑时，先想清楚该落在哪个模块：
 *   展示模板 → ui.js   分批加载 → pager.js   某个视图 → views.js
 *   地址栏 / 状态 → router.js   网络请求 → api.js   事件绑定 → 本文件
 * =========================================================================== */

import { $ } from './ui.js';
import { fetchConfig } from './api.js';
import { renderHotTools } from './views.js';
import {
  state, navigateTo, applyUrlState, submitSearch, selectTag,
  openTool, loadTagsAndSync, retryCurrent
} from './router.js';

/* ---------------------------- 页脚：服务地址 ---------------------------- */

/** 访问地址从服务端读，页面内不写死；直接以 file:// 打开时自动隐藏 */
async function loadServerAddress() {
  const cfg = await fetchConfig();
  if (!cfg || !cfg.url) return;
  const el = $('#serverAddr');
  el.textContent = 'Server · ' + cfg.url;
  el.classList.remove('hidden');
}

/* -------------------------------- 初始化 -------------------------------- */

function init() {
  // 视图外壳先立起来：Hero、标题、导航选中态、页脚都不等数据，
  // 所以数据服务全挂的时候页面依然是完整的，只是没有工具
  renderHotTools();     // 首页热门（自己带失败态）
  applyUrlState();      // 按地址栏还原：直达 /tools、/search?q=、刷新、分享都能正确落地
  loadServerAddress();

  // 分类清单单独取：它到手之前分类条不渲染，抵达后再补一次地址校验
  // （深链里的分类存不存在，得等清单来了才知道）
  loadTagsAndSync();

  // 顶部导航：拦截点击做站内跳转；中键 / Ctrl+点击 走浏览器默认新开标签
  $('#nav').addEventListener('click', (e) => {
    const link = e.target.closest('.nav-link');
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    state.q = '';                 // 点导航 = 看完整列表，搜索词与分类一并清掉
    state.tag = '';
    $('#searchInput').value = '';
    navigateTo(link.dataset.view, { open: true });
  });

  // 搜索框：打字不触发，回车提交；放大镜按钮等效于回车
  const input = $('#searchInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitSearch(); }
    if (e.key === 'Escape') { input.value = ''; }   // 只清输入框，不提交
  });
  $('#searchBtn').addEventListener('click', submitSearch);

  // 分类筛选条：工具页与搜索结果页两处都接同一套逻辑
  ['#tagFilter', '#searchTagFilter'].forEach(sel => {
    const box = $(sel);
    if (!box) return;
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tag]');
      if (btn) selectTag(btn.dataset.tag);
    });
  });

  // 卡片与重试按钮都走这一个委托监听。
  // 卡片点击必须在同步栈里开窗（见 router.js 的 openTool）；重试按钮没有这个限制。
  //
  // data-tool-local 是「这个本地工具的本体在不在」的探查结果，由 views.js 在卡片渲染后写好：
  // 这一步不能挪到点击时做 —— 中间 await 一下，window.open 就会被当弹窗拦掉。
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-retry]')) { retryCurrent(); return; }

    const card = e.target.closest('[data-tool-id]');
    if (!card) return;
    openTool(
      card.dataset.toolUrl,
      card.dataset.toolName,
      card.dataset.toolLocal === 'missing'
    );
  });

  // 浏览器前进 / 后退
  window.addEventListener('popstate', applyUrlState);
}

// type="module" 的脚本是延迟执行的：执行时 DOM 已经解析完，
// 但 DOMContentLoaded 要等所有延迟脚本跑完才触发，所以两种情形都要接住。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
