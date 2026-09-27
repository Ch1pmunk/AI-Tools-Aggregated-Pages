/**
 * 数据源：json-dir —— 读一个目录，每个 .json 文件一条工具记录。
 * ---------------------------------------------------------------------------
 * 默认数据源。配置：
 *   DATA_DIR   目录路径，相对项目根目录，默认 catalog
 *
 * 约定：
 *   · 跳过 `_` 和 `.` 开头的文件（`_template.json` 是给你复制用的模板）
 *   · **id 的权威来源是文件里的 id 字段，不是文件名**。两者不一致会打一条警告：
 *     文件名 foo.json 里写着 id: "bar"，看着像一个人其实有两个身份，这种问题不报会很难查
 *   · 增删工具 = 增删文件。不用改代码、不用重启，刷新页面即可
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { createRereadingSource, dataSourceUnavailable, dropLogger } = require('../core/memory-source');
const { warnOnce } = require('../core/log');

/* ===========================================================================
 * ★★★ 要换清单文件放哪，改这一行就行 ★★★
 * 相对项目根目录。设了 DATA_DIR 环境变量则以环境变量为准。
 * 换数据源（DEFAULT_SOURCE）之后这个目录就不再被读了，见 core/resolve.js。
 * =========================================================================== */
const DEFAULT_DIR = 'catalog';

function create({ env, root }) {
  const dir = path.resolve(root, env.DATA_DIR || DEFAULT_DIR);

  async function readRecords() {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // 目录不存在 / 没权限 = 数据源不可用。这是「取不到数据」，
      // 与「目录里没有工具」必须区分开，前端对这两种情况的处理完全不同。
      throw dataSourceUnavailable(`数据目录读不到：${dir}（${err.code || err.message}）`, err);
    }

    const names = entries
      .filter(e => e.isFile() && e.name.endsWith('.json') && !/^[._]/.test(e.name))
      .map(e => e.name)
      .sort();   // 读盘顺序也固定下来，出问题时可复现

    const records = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        const idInFile = raw && typeof raw.id === 'string' ? raw.id.trim() : '';
        if (idInFile && idInFile !== path.basename(name, '.json')) {
          warnOnce(
            'id-mismatch:' + name,
            `[json-dir] ${name} 里的 id="${idInFile}" 与文件名不一致，以文件里的 id 为准`
          );
        }
        records.push(raw);
      } catch (err) {
        // 单个文件坏掉只丢这一条，其余照常返回 —— 不能让一个坏文件把整个列表打成 500
        warnOnce('bad:' + name, `[json-dir] 跳过 ${name}：${err.message}`);
      }
    }
    return records;
  }

  return createRereadingSource({
    name: 'json-dir',
    describe: dir,
    readRecords,
    onDrop: dropLogger('json-dir')
  });
}

module.exports = { create };
