/**
 * 内存数据源 —— **语义基准实现**。
 * ---------------------------------------------------------------------------
 * 拿一批原始记录，按契约提供 list / tags / hot。所有「从文件读出来」的适配器都是
 * 「读盘 → 交给这里」，彼此只差读盘那一步。
 *
 * 之所以把它单独抽出来当基准：mysql 适配器必须把过滤排序下推成 SQL，是唯一会分叉的
 * 地方。有这么一个可执行、可对拍的参照物，分叉才是可控的（对拍用例见 docs/adapters.md）。
 * ---------------------------------------------------------------------------
 */

const { normalizeAll, compareTools, compareHot, applyFilters, paginate } = require('./normalize');

/**
 * @param {Array} records  原始记录（未归一化，坏记录会被丢弃）
 * @param {{name?: string, onDrop?: (raw: any, reason: string) => void}} [options]
 */
function createMemoryAdapter(records, options = {}) {
  const name = options.name || 'memory';

  // 归一化 → 丢弃坏记录与重复 id → 只留 enabled。
  // 契约规定：适配器不许把 enabled=false 的工具发出去，计数和分类清单同理。
  const tools = normalizeAll(records, options.onDrop)
    .filter(t => t.enabled)
    .sort(compareTools);

  return {
    name,

    /** 分页列表。totalAll = 忽略 q/tag 的条数，供「筛选出 n / m 个工具」用 */
    async list({ q, tag, page, pageSize }) {
      const matched = applyFilters(tools, { q, tag });
      return Object.assign(paginate(matched, page, pageSize), { totalAll: tools.length });
    },

    /**
     * 分类清单：**按使用次数降序，其次字典序升序**。
     * 定死这个规则是为了确定性（否则文件读出来的顺序会泄漏到页面上），
     * 也让常用分类自然靠前。mysql 版一条 GROUP BY ... ORDER BY COUNT(*) DESC, tag ASC 对上。
     */
    async tags() {
      const count = new Map();
      for (const tool of tools) {
        for (const tag of tool.tags) count.set(tag, (count.get(tag) || 0) + 1);
      }
      return [...count.keys()].sort(
        (a, b) => (count.get(b) - count.get(a)) || (a < b ? -1 : a > b ? 1 : 0)
      );
    },

    /**
     * 首页热门：点赞数降序，同点赞数按 order / id 升序，取前 limit 个。
     *
     * 注意这里**不补数** —— 只有 3 个工具就返回 3 个。「首页要摆满 6 个槽位」
     * 是版面事实，属于页面（HOT_SLOTS 在客户端），服务端只负责按规则给出它有的那几个。
     * 补数会把「本站只有 3 个工具」这件事藏起来，而页面恰恰需要知道这件事才好画占位卡。
     */
    async hot(limit) {
      return tools.slice().sort(compareHot).slice(0, limit);
    }
  };
}

module.exports = { createMemoryAdapter };
