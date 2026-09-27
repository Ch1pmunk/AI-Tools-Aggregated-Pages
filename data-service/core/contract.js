/**
 * 数据契约 —— 字段名、默认值、上限。
 * ---------------------------------------------------------------------------
 * 这是「前后端唯一契约」的代码形式，与 docs/data-contract.md 是同一份东西，
 * **改这里必须同时改那份文档**，否则下一轮改动依据就是错的。
 *
 * 工具记录的形状（三种存储共用，见 normalizeTool）：
 *   id          string   唯一标识，必填
 *   name        string   工具名称，必填
 *   description string   一句话描述
 *   tags        string[] 分类标签（工具页的分类筛选条由此派生）
 *   icon        string   图标（emoji）
 *   url         string   外链或站内地址。**只允许 http/https，或站内单个 / 开头的相对地址**
 *                        （本地部署的项目就住在本站的 /tools/<项目名>/ 下）。其余一律归一化为空串
 *   enabled     boolean  false 表示不展示（由服务端过滤掉，不会发给前端）
 *   likes       number   点赞数，非负整数，缺省 0。**首页热门推荐的排序依据**
 *   order       number   排序键，越小越前，缺省 1000
 *
 * order 存在的理由：数据来自文件目录时，readdir() 的顺序由文件系统决定、跨平台不一致，
 * 没有确定的排序键，分页就会重复和漏项。排序规则固定为 order 升序、同 order 按 id 升序。
 *
 * likes 存在的理由：热门推荐要有个**能被累加**的优先级。布尔标记只能表达「是/不是热门」，
 * 没有程度之分，也就没法排序 —— 而排序一旦不确定，首页那 6 张卡今天和明天就不是同一批。
 * 这个值将来直接对应数据库里的一列，所以现在就把它当作真字段看待，不是临时凑的。
 * ---------------------------------------------------------------------------
 */

/**
 * 每页条数：默认值与上限。上限是防「一次把全部拉走」，不是限制收录规模。
 * PAGE_MAX 只是给页码一个能读懂的上界（否则报错里会出现 9007199254740991 这种数）。
 */
const PAGE_SIZE_DEFAULT = 12;
const PAGE_SIZE_MAX = 60;
const PAGE_MAX = 10000;

/** 关键词与分类的长度上限，防超长字符串 */
const Q_MAX = 100;
const TAG_MAX = 50;

/** 首页热门推荐：默认与上限 */
const HOT_LIMIT_DEFAULT = 6;
const HOT_LIMIT_MAX = 24;

/** order 缺省值 */
const ORDER_DEFAULT = 1000;

/** likes 缺省值（负数、NaN、非数字一律归 0 —— 点赞数没有负的） */
const LIKES_DEFAULT = 0;

module.exports = {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PAGE_MAX,
  Q_MAX,
  TAG_MAX,
  HOT_LIMIT_DEFAULT,
  HOT_LIMIT_MAX,
  ORDER_DEFAULT,
  LIKES_DEFAULT
};
