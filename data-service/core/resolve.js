/**
 * 数据源选择 —— 按 DATA_SOURCE 环境变量挑一个适配器。
 * ---------------------------------------------------------------------------
 * 启动时决定一次，运行期不换。热插拔没有实际需求，只会让「现在到底读的是哪份数据」
 * 变模糊，排障时最怕这个。
 *
 * 可用的实现：
 *   json-dir    读一个目录，每个 .json 一条记录（默认，见 catalog/）
 *   json-file   读一个 .json 文件，顶层是数组
 *   js-file     读一个 .js 文件，module.exports 是数组
 *   mysql       连 MySQL（**未实测**，见 adapters/mysql.js 文件头）
 * ---------------------------------------------------------------------------
 */

const path = require('path');

/** 项目根目录（data-service/core/ 往上两级） */
const ROOT = path.resolve(__dirname, '..', '..');

/* ===========================================================================
 * ★★★ 要换数据源，改这一行就行 ★★★
 * ---------------------------------------------------------------------------
 * 列表 / 清单文件 / 数据库三种来源在代码里的差别只有这一个字符串。
 * 改这里等价于设 DATA_SOURCE 环境变量（环境变量优先，方便临时试）。
 *
 *   'json-dir'    读 catalog/ 目录，每个 .json 一条记录   ← 现在用的
 *   'json-file'   读单个 .json（顶层是数组）       位置由 DATA_FILE 定
 *   'js-file'     读单个 .js（module.exports 是数组）  同上
 *   'mysql'       连 MySQL 两张表                 见 adapters/mysql.js（**未实测**）
 *
 * 换过去之后，**页面代码一行不用改，静态服务也不用动** ——
 * 它们只认 /api/tools 的响应形状，不关心那批记录是从哪来的。
 * =========================================================================== */
const DEFAULT_SOURCE = 'json-dir';

const ADAPTERS = {
  'json-dir': () => require('../adapters/json-dir'),
  'json-file': () => require('../adapters/json-file'),
  'js-file': () => require('../adapters/js-file'),
  mysql: () => require('../adapters/mysql')
};

/** 可选的数据源名，用于报错提示 */
function availableSources() {
  return Object.keys(ADAPTERS);
}

/**
 * 建一个数据源适配器实例。
 * 适配器内部要用的配置（目录、表名、连接串）也从 env 读，外壳不替它解析。
 */
function createDataSource(env = process.env) {
  const name = String(env.DATA_SOURCE || DEFAULT_SOURCE).trim();
  const load = Object.prototype.hasOwnProperty.call(ADAPTERS, name) ? ADAPTERS[name] : null;

  if (!load) {
    throw new Error(
      `未知的数据源 DATA_SOURCE=${name}。可选：${availableSources().join(' / ')}`
    );
  }

  return load().create({ env, root: ROOT });
}

module.exports = { createDataSource, availableSources, DEFAULT_SOURCE, ROOT };
