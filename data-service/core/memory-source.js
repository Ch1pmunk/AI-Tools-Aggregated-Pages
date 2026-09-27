/**
 * 把「每次都重新取一遍原始记录」这件事包成一个数据源适配器。
 * ---------------------------------------------------------------------------
 * 三个文件类适配器（目录 / 单个 json / 单个 js）除了「怎么把记录读出来」之外完全相同，
 * 差别只在传进来的 readRecords。抽在这里，免得三份 list/tags/hot 各写一遍、日后改一处漏两处。
 *
 * 每次都重新读、不做缓存，是刻意的：改了数据文件刷新页面就生效、不用重启服务，
 * 是这个项目最要紧的运维体验。代价是每个请求几十次 readFile —— 数据量到上千条再加
 * mtime 缓存也不迟，那时适配器对外接口不变。
 * ---------------------------------------------------------------------------
 */

const { createMemoryAdapter } = require('./memory-adapter');
const { warnOnce } = require('./log');

/**
 * @param {{
 *   name: string,
 *   readRecords: () => Promise<Array>,
 *   describe?: string,        // 当前读的是哪个文件/目录，供 /api/health 与排障显示
 *   onDrop?: (raw: any, reason: string) => void
 * }} options
 */
function createRereadingSource({ name, readRecords, describe, onDrop }) {
  // 每次调用都新建一个 memory 引擎：归一化 → 丢弃坏记录 → 过滤 enabled → 排序
  async function engine() {
    return createMemoryAdapter(await readRecords(), { name, onDrop });
  }

  return {
    name,
    describe,
    async list(query) { return (await engine()).list(query); },
    async tags() { return (await engine()).tags(); },
    async hot(limit) { return (await engine()).hot(limit); }
  };
}

/**
 * 构造「数据源不可用」错误。
 * 外壳见到 code === 'DATA_SOURCE_UNAVAILABLE' 会转成 500 并说明原因 ——
 * 这与「目录读得到、只是里面没有工具」是两回事，前端也要能区分：
 * 前者不许显示任何数字，后者可以显示「共 0 个工具」。
 */
function dataSourceUnavailable(message, cause) {
  const err = new Error(message);
  err.code = 'DATA_SOURCE_UNAVAILABLE';
  if (cause) err.cause = cause;
  return err;
}

/** 丢弃坏记录时的统一日志（按记录指纹去重，避免每请求刷屏） */
function dropLogger(name) {
  return (raw, reason) => {
    const key = name + ':drop:' + (raw && raw.id ? raw.id : JSON.stringify(raw));
    warnOnce(key, `[${name}] 丢弃一条记录：${reason}`);
  };
}

module.exports = { createRereadingSource, dataSourceUnavailable, dropLogger };
