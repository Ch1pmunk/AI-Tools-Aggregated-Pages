/**
 * 数据源：json-file —— 读一个 .json 文件，顶层是工具记录数组。
 * ---------------------------------------------------------------------------
 * 配置：
 *   DATA_FILE  文件路径，相对项目根目录，默认 catalog.json
 *
 * 存在的意义：还没想好怎么把工具分文件放的时候，先全部塞进一个文件里也能跑。
 * 与 json-dir 的差别只有「怎么把记录读出来」这一步，语义完全一致。
 *
 * 注意：整个文件坏掉（不是合法 JSON、顶层不是数组）算数据源不可用，返回 500。
 * 这与 json-dir 里「单个文件坏掉只丢一条」不同 —— 这里只有一个文件，坏了就是全没了。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { createRereadingSource, dataSourceUnavailable, dropLogger } = require('../core/memory-source');

function create({ env, root }) {
  const file = path.resolve(root, env.DATA_FILE || 'catalog.json');

  async function readRecords() {
    let text;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch (err) {
      throw dataSourceUnavailable(`数据文件读不到：${file}（${err.code || err.message}）`, err);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw dataSourceUnavailable(`数据文件不是合法 JSON：${file}（${err.message}）`, err);
    }

    if (!Array.isArray(parsed)) {
      throw dataSourceUnavailable(`数据文件顶层必须是数组：${file}`);
    }
    return parsed;
  }

  return createRereadingSource({
    name: 'json-file',
    describe: file,
    readRecords,
    onDrop: dropLogger('json-file')
  });
}

module.exports = { create };
