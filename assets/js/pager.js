/* ===========================================================================
 * pager.js —— 分批加载控制器（按页向服务端取数）
 * ---------------------------------------------------------------------------
 * 卡片多了不能一次全塞进 DOM。这里管一个卡片容器 + 一行状态文字：
 * 一次只取一页、只渲染一页，滚到列表底部附近再取下一页。
 *
 * 与数据来源无关：fetchPage 由调用方给，取出来的东西它不认识也不关心，
 * 所以工具页和搜索结果页共用同一个实现。
 *
 * 三件不做会出事的事，都在下面标了注释：
 *   · 竞态令牌 —— 没有它，慢的旧响应会落在新筛选结果后面
 *   · 空页保险 —— 没有它，服务端一旦给出「空页却说还有」就会无限打请求
 *   · 渲染下限 —— 只是让加载态看得见，不拖慢请求本身
 * =========================================================================== */

import { TEXTS, failureHtml } from './ui.js';

/** 每页多少张卡片（桌面 3 列 × 4 行）。想让一页多出几张就调这里 */
export const PAGE_SIZE = 12;

/**
 * 触底提前量（像素）：状态行离视口底部还有这么远就开始取下一页。
 * 0 = 状态行真的露出来才取 —— 「正在加载更多工具中……」那一行才看得到。
 * 调大能提前备货、滚起来更顺，但那一行会在进入视口前就被顶走，等于没写。
 */
export const PRELOAD_PX = 0;

/**
 * 一页渲染的最短展示时间（毫秒）。
 *
 * 这是**渲染下限，不是请求延迟**：请求一发出就走，只是「出结果」被压后到至少这么久。
 * 本地服务几十毫秒就回来了，不设下限的话「正在加载更多工具中……」只闪一帧，
 * 写了等于没写；用户看到的是内容凭空出现，而不是「在加载」。
 * 设 0 = 不留，最快，但看不到加载态。
 */
export const MIN_VISIBLE_MS = 350;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {object}   opts
 * @param {HTMLElement} opts.grid      卡片容器
 * @param {HTMLElement} opts.status    状态行元素（失败时这里会长出重试按钮）
 * @param {(item:object)=>string} opts.cardOf  单张卡片的 HTML
 * @param {(page:number)=>Promise<object>} opts.fetchPage  取第 page 页；必须返回 {items, total, totalAll, hasMore}
 * @param {number}  [opts.pageSize]
 * @param {number}  [opts.minVisibleMs]
 * @param {(meta:{total:number,totalAll:number,page:number})=>void} [opts.onMeta]  成功时回调，用来写计数
 * @param {(err:Error)=>void} [opts.onError]   失败时回调，用来清掉计数、必要时弹提示。
 *        传的是原始错误对象 —— 带上它才分得出超时和连不上（`err.timeout`）。
 */
export function createBatchLoader({
  grid, status, cardOf, fetchPage,
  pageSize = PAGE_SIZE,
  minVisibleMs = MIN_VISIBLE_MS,
  onMeta, onError
}) {
  let token = 0;          // 竞态令牌：每次重来都 +1，在途请求的响应回来对不上就作废
  let loadedPage = 0;     // 已成功渲染到第几页
  let moreExists = true;  // 是否还有下一页。首次请求前假定有，否则第一次就发不出去
  let total = null;       // 最近一次成功响应里的总条数
  let inFlight = false;
  let failed = false;
  let lastError = null;   // 记住失败原因，好在状态行里说清楚是超时还是没连上

  /* ------------------------------ 状态行 ------------------------------ */

  function paintStatus() {
    if (failed) { status.innerHTML = failureHtml(lastError); return; }
    if (inFlight) {
      status.textContent = loadedPage === 0 ? TEXTS.loadingFirst : TEXTS.loadingMore;
      return;
    }
    // 还没发出过任何请求，或成功但一条都没有：留空。
    // 「0 条」由空状态块说明，状态行再说一遍就成了两句话讲同一件事。
    if (loadedPage === 0 || total === 0) { status.textContent = TEXTS.empty; return; }
    status.textContent = moreExists ? TEXTS.loadingMore : TEXTS.allLoaded;
  }

  /* ------------------------------ 触底判定 ------------------------------ */

  /** 状态行是否已经进到视口附近（离底部不足 PRELOAD_PX 就算） */
  function inZone() {
    // 视图隐藏时状态行量不出位置（rect 全是 0），不能当成「在视口里」，
    // 否则会把整份列表一次渲染光 —— 分批就白做了
    if (!status.getClientRects().length) return false;
    return status.getBoundingClientRect().top <= window.innerHeight + PRELOAD_PX;
  }

  /* ------------------------------- 取一页 ------------------------------- */

  async function loadPage(n) {
    const myToken = token;
    inFlight = true;
    failed = false;
    paintStatus();

    try {
      // 请求立刻发出，下限只加在渲染这一步上 —— 不是人为拖慢请求
      const [res] = await Promise.all([fetchPage(n), sleep(minVisibleMs)]);

      // 期间筛选项变了：这一包整个丢掉，连计数都不许写。
      // 没有这道闸，慢的旧响应会落在新结果后面，出现「筛了办公却冒出演示文稿的卡」
      //
      // （超时的响应轮不到这里处理 —— AbortSignal 在超时那一刻就把请求掐了，
      //   它压根回不来。这里挡的是「成功但已经过期」的响应。）
      if (myToken !== token) return;

      lastError = null;

      // 空页保险：说还有下一页、却给了一页空的 —— 信数据本身，就此收手。
      // 没有它，服务端状态一旦不一致，这里会无限打请求
      moreExists = res.items.length === 0 ? false : res.hasMore !== false;
      total = Number(res.total) || 0;
      loadedPage = n;

      if (res.items.length) grid.insertAdjacentHTML('beforeend', res.items.map(cardOf).join(''));
      if (onMeta) onMeta({ total: res.total, totalAll: res.totalAll, page: n });
    } catch (err) {
      if (myToken !== token) return;   // 已经重来过了，这次失败跟新结果无关
      failed = true;
      lastError = err;
      paintStatus();                   // 先让状态行说出原因（超时 / 连不上），再通知调用方
      if (onError) onError(err);
    } finally {
      if (myToken === token) {
        inFlight = false;
        paintStatus();
        // 一屏还没铺满就接着取，否则状态行会挂在半空
        if (!failed && moreExists && inZone()) requestMore();
      }
    }
  }

  /** 所有「想再要一页」的入口都走这里，闸门只设一处 */
  function requestMore() {
    if (inFlight || failed || !moreExists) return;
    loadPage(loadedPage + 1);
  }

  const observer = new IntersectionObserver(
    entries => { if (entries.some(e => e.isIntersecting)) requestMore(); },
    { rootMargin: `${PRELOAD_PX}px 0px` }
  );
  observer.observe(status);

  /** 把这个列表彻底清空并作废在途请求。用于「这个视图现在不该有内容」 */
  function clear() {
    token++;
    loadedPage = 0;
    moreExists = true;
    total = null;
    inFlight = false;
    failed = false;
    lastError = null;
    grid.innerHTML = '';
    status.textContent = TEXTS.empty;
  }

  return {
    observer,   // 留个引用，免得观察器被当作垃圾回收

    /** 筛选条件变了：清空重来，从第 1 页开始 */
    reload() {
      clear();
      loadPage(1);
    },

    clear,

    /**
     * 失败后点重试。
     * 从**失败的那一页**接着取，不从头再来 —— 已经渲染出来的卡片留着，
     * 否则滚了半天的用户点一下重试就被踹回页首。
     */
    retry() {
      if (inFlight) return;
      failed = false;
      paintStatus();
      loadPage(loadedPage + 1);
    },

    /**
     * 这个列表是不是已经有内容了（或在取、或失败了）。
     * 调用方用它做「同一条件重复渲染就别重来」的判断 —— 重来会白白重取第 1 页，
     * 还会把用户滚了半天的位置打回顶部。
     */
    hasLoaded() { return loadedPage > 0 || inFlight || failed; }
  };
}
