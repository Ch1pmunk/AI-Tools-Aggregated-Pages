/**
 * 数据源：js-file —— 读一个 .js 文件，module.exports 是工具记录数组。
 * ---------------------------------------------------------------------------
 * 配置：
 *   DATA_FILE  文件路径，相对项目根目录，默认 catalog.js
 *
 * 和 json-file 几乎一样，只多两点：
 *   · 文件里可以写注释、可以算（例如 tags 用常量拼），比 JSON 好写一点
 *   · 每次请求都清掉 require 缓存再读，所以改完文件刷新即生效，与 json-dir 的体验一致
 *
 * 注意：文件里写的是代码，会被真的执行。只放自己写的文件，不要指到别人的东西上。
 * ---------------------------------------------------------------------------
 */

const path = require('path');
const { createRereadingSource, dataSourceUnavailable, dropLogger } = require('../core/memory-source');

function create({ env, root }) {
  const file = path.resolve(root, env.DATA_FILE || 'catalog.js');

  async function readRecords() {
    let loaded;
    try {
      // 清缓存：不清的话第二次请求拿到的还是第一次的旧值，「改完刷新即生效」就没了
      delete require.cache[require.resolve(file)];
      loaded = require(file);
    } catch (err) {
      throw dataSourceUnavailable(`数据文件加载失败：${file}（${err.message}）`, err);
    }

    // 允许 module.exports = [...] 或 module.exports = { tools: [...] }，两种都常见
    const records = Array.isArray(loaded) ? loaded : loaded && loaded.tools;
    if (!Array.isArray(records)) {
      throw dataSourceUnavailable(`数据文件的 module.exports 必须是数组（或 { tools: [...] }）：${file}`);
    }
    return records;
  }

  return createRereadingSource({
    name: 'js-file',
    describe: file,
    readRecords,
    onDrop: dropLogger('js-file')
  });
}

module.exports = { create };
