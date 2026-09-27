/* ===========================================================================
 * ui.js —— 纯展示层：DOM 小工具、卡片模板、空状态、文案常量
 * ---------------------------------------------------------------------------
 * 这一层不做任何决策，只把传进来的东西变成 HTML 字符串。
 * 它不 import 任何业务模块（不知道 state、不知道数据从哪来），
 * 所以任何视图都能拿去用，也不会和数据层互相牵制。
 *
 * 所有插入 HTML 的地方都必须过 esc()：文案将来来自数据文件，
 * 一旦有人往 name/description 里写 <script>，不过滤就是注入口。
 * =========================================================================== */

/** querySelector 简写 */
export const $ = (sel) => document.querySelector(sel);

/** 极简转义，避免文案里的特殊字符破坏结构 */
export function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------------- 轻提示 ------------------------------- */

let toastTimer = null;

/** 轻提示（toast） */
export function showToast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 1800);
}

/* ------------------------------ 卡片模板 ------------------------------ */

/** 分类标签 HTML */
export function tagsHtml(tags) {
  return (tags || []).map(t => `<span class="pill">${esc(t)}</span>`).join('');
}

/**
 * 分类胶囊按钮。activeTag 由调用方传入（这里不读全局状态，保持纯展示）。
 * value 既是筛选值也是 data-tag，空串表示「全部」。
 */
export function pillButton(label, value, activeTag) {
  const active = activeTag === value ? ' pill-active' : '';
  return `<button type="button" class="pill${active}" data-tag="${esc(value)}">${esc(label)}</button>`;
}

/**
 * 卡片右下角的点赞数。
 *
 * 它是一个**读数，不是一个按钮**：本站没有任何写入接口（见 Readme 第八节「只读」），
 * 这一块刻意不给边框、不给底色、不给 hover 反馈 —— 长得像能点是最坏的结果，
 * 因为点了没反应会被当成页面坏了，而不是当成「这里本来就不能点」。
 * 所以也别让它跟着卡片 hover 变色：卡片 hover 表达的是「能打开」，
 * 点赞数和那个动作没有关系（右上角那个箭头才是）。
 *
 * 0 要照实画出来，不能画成空白 —— 空白和「不知道有多少赞」长得一模一样，
 * 而这两件事必须能分开（见 Readme 第十二节）。这个 0 是「确实一个赞都没有」，
 * 和「未能读取工具数据」是两个完全不同的意思，不许互相顶替。
 * 画 0 不算「把不知道说成没有」：likes 缺省就是 0，那是记录契约里写明的默认值
 * （core/normalize.js 的 toLikes）；真拿不到数据时根本不画卡片，也就没有这个数。
 *
 * 传进来的值理论上已经过 toLikes() 归一化，但这里仍然自己兜一道：
 * 这一层是纯展示，不该假设上游一定没漏。
 */
function likesHtml(likes) {
  const n = Number(likes);
  const shown = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return `<span class="shrink-0 inline-flex items-center gap-1 text-[12px] leading-none text-muted tabular-nums">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.53L12 21.35Z"></path>
        </svg><span class="sr-only">点赞数</span>${shown}
      </span>`;
}

/** 工具卡片 HTML */
export function cardHtml(tool) {
  const hasUrl = Boolean(String(tool.url || '').trim());
  const status = hasUrl
    ? `<svg class="w-4 h-4 text-muted group-hover:text-ink group-hover:translate-x-0.5 transition-all"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <path d="M7 17 17 7"></path><path d="M8 7h9v9"></path>
       </svg>`
    : `<span class="pill">即将上线</span>`;

  // url 与 name 直接写进 data-* 属性：点击时同步读出来就能开窗，
  // 既不用维护内存索引，也不用在点击时去查接口（查接口就来不及了，见 router.js 的 openTool）。
  return `
    <button type="button" class="tool-card group w-full min-h-[188px] p-6 text-left flex flex-col"
            data-tool-id="${esc(tool.id)}"
            data-tool-url="${esc(tool.url || '')}"
            data-tool-name="${esc(tool.name)}">
      <div class="flex items-start justify-between gap-4">
        <span class="w-11 h-11 shrink-0 rounded-xl border border-line bg-cream flex items-center justify-center text-[20px] leading-none"
              aria-hidden="true">${esc(tool.icon || '◆')}</span>
        <span data-tool-status>${status}</span>
      </div>
      <h3 class="mt-5 text-[18px] font-semibold tracking-[-0.01em]">${esc(tool.name)}</h3>
      <p class="mt-2 text-[13.5px] leading-[1.75] text-muted flex-1">${esc(tool.description)}</p>
      <div class="mt-4 flex items-end justify-between gap-3">
        <div class="min-w-0 flex flex-wrap gap-1.5">${tagsHtml(tool.tags)}</div>
        ${likesHtml(tool.likes)}
      </div>
    </button>`;
}

/**
 * 「本地副本未就位」的角标。
 *
 * 由探查结果**事后**贴上去的，不在 cardHtml 里生成 —— 因为卡片渲染出来的那一刻
 * 还不知道工具本体在不在（那是要向服务端问一次的事）。
 * 说的是渲染当刻的事实（刚探过，确实没有），不是会过期的说法。
 */
export const LOCAL_MISSING_TEXT = '本地副本未就位';

export function localMissingPillHtml() {
  return `<span class="pill">${LOCAL_MISSING_TEXT}</span>`;
}

/** 占位卡：撑出网格结构，等待后续工具填充 */
export function placeholderCardHtml(index) {
  return `
    <div class="slot-card min-h-[188px] p-6 flex flex-col justify-between">
      <span class="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">
        ${String(index).padStart(2, '0')} · 预留位
      </span>
      <span class="text-[13px] text-muted">待收录</span>
    </div>`;
}

/* ------------------------------ 空状态块 ------------------------------ */

/**
 * 铺满整行的空状态块（3 列网格里跨 3 列）。
 * 只在**成功取到数据且结果为空**时用 —— 取不到数据时用的是失败态，两者措辞和含义都不同。
 */
export function emptyStateHtml(title, hint) {
  return `
    <div class="col-span-3 border border-dashed border-line rounded-2xl px-6 py-16 text-center">
      <p class="text-[15px] font-medium">${esc(title)}</p>
      ${hint ? `<p class="mt-2 text-[13px] text-muted">${esc(hint)}</p>` : ''}
    </div>`;
}

/* ------------------------------ 文案常量 ------------------------------ */

/**
 * 状态行文案。集中放在这里，避免同一句话在多处各写一遍、改一处漏一处。
 * 这几句都是「渲染当刻成立的状态」，不是会过期的规模描述（见 Readme 第十二节）。
 */
export const TEXTS = {
  loadingFirst: '正在加载工具……',
  loadingMore: '正在加载更多工具中……',
  allLoaded: '已加载全部工具',
  empty: ''
};

/**
 * 「取不到数据」的唯一文案，三处（首页、工具页、搜索页）共用一份实例，
 * 避免同一件事在三处各写一句、措辞慢慢漂开。
 *
 * 注意它和「暂无工具收录」「没有匹配的工具」的区别：
 *   前者是「不知道有几条」，后者是「知道，就是 0 条」。
 * 两者绝不能长得像，更不能互相顶替 —— 见 Readme 第十二节。
 */
export const FAILURE_TEXT = '未能读取工具数据。';

/**
 * 超时的文案，和上面那句分开。
 *
 * 不分开的话，用户看到「未能读取工具数据」只能猜；而超时和连不上**要查的东西不一样**：
 * 连不上是「服务没起来」，超时是「服务起来了但不应答（卡住了）」。
 * 这两句话是排障的唯一线索，混成一句就白丢了。
 */
export const TIMEOUT_TEXT = '读取工具数据超时。';

/** 按失败原因挑文案：超时一种，其余一种 */
function failureTextOf(err) {
  return err && err.timeout ? TIMEOUT_TEXT : FAILURE_TEXT;
}

/** 失败态：一行文字 + 重试按钮。用于列表下方的状态行（#toolMore / #searchMore） */
export function failureHtml(err) {
  return `<span>${failureTextOf(err)}</span>
    <button type="button" class="pill ml-2" data-retry>重试</button>`;
}

/** 失败态：铺满整行的虚线框版本。用于首页热门区（那里没有状态行可用） */
export function failureStateHtml(err) {
  return `
    <div class="col-span-3 border border-dashed border-line rounded-2xl px-6 py-16 text-center">
      <p class="text-[15px] font-medium">${failureTextOf(err)}</p>
      <button type="button" class="pill mt-4" data-retry>重试</button>
    </div>`;
}
