/**
 * 数据源：mysql —— 把过滤、排序、分页下推成 SQL。
 * ===========================================================================
 * ⚠️ 完整实现，但**作者本机没有 MySQL 实例，一个字都没实测过**。
 *    接入前请逐条验完下面这张清单，验不过就别切到 DATA_SOURCE=mysql。
 *
 * 接入前必须验证（详见 docs/adapters.md）：
 *   1. `npm i mysql2` 装得上。**mysql2 不写进 package.json 的 dependencies** ——
 *      本项目零依赖，只有真的要用 MySQL 才装。没装就在工厂里抛中文指引，不让服务起不来。
 *   2. MySQL ≥ 5.7（8.0 推荐），且库和表都是 **utf8mb4**。icon 存的是 emoji，
 *      老的 utf8（三字节）会把它存成问号。验：SELECT @@character_set_database;
 *   3. 已执行 schema.sql 建好 tools / tool_tags 两张表。
 *   4. 关键词里的 % 和 _ 不会变成通配符（LIKE 必须转义，见 buildWhere）。
 *   5. LIMIT / OFFSET 用占位符传数字，绝不字符串拼接。
 *   6. total 与 totalAll 两个 COUNT 的差异符合预期（前者是筛选后，后者是全部 enabled）。
 *   7. 空库返回 { items: [], total: 0, hasMore: false }，而不是报错。
 *   8. Ctrl+C 时连接池被 close() 掉（外壳在退出时调 close）。
 *   9. **与 json 适配器对拍**：同一批数据、同一个 q/tag，
 *      两个适配器的 items 与 total 必须完全一致 —— 这是发现语义分叉的唯一手段。
 *
 * 配置（二选一）：
 *   MYSQL_URL   mysql://user:pass@host:3306/dbname          ← 优先
 *   或分项：MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
 * ===========================================================================
 *
 * 与内存版**唯一允许分叉的地方**：过滤、排序、分页在这里由 SQL 做（不这么做就得把整表
 * 读进内存，那数据库就白用了）。归一化仍然走 core/normalize，没有分叉。
 */

const { normalizeTool } = require('../core/normalize');
const { dataSourceUnavailable } = require('../core/memory-source');
const { warnOnce } = require('../core/log');

const TOOLS_TABLE = 'tools';
const TAGS_TABLE = 'tool_tags';

/** 动态加载 mysql2；没装就给一条能照做的中文指引，而不是一句 MODULE_NOT_FOUND */
function loadMysql2() {
  try {
    return require('mysql2/promise');
  } catch (err) {
    throw new Error(
      '数据源 mysql 需要 mysql2，但它没有安装。请执行：npm i mysql2\n' +
      '（本项目其余部分零依赖，所以没有把它列进 package.json —— 用不到 MySQL 就不必装。）'
    );
  }
}

/**
 * LIKE 的通配符转义。用户输入的 % 和 _ 必须当普通字符，
 * 否则搜一个 % 就会匹配到全部记录。反斜杠自己也要先转义，且 SQL 里用 ESCAPE '\\' 声明。
 */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, ch => '\\' + ch);
}

function create({ env }) {
  const mysql = loadMysql2();

  const pool = env.MYSQL_URL
    ? mysql.createPool(env.MYSQL_URL)
    : mysql.createPool({
        host: env.MYSQL_HOST || '127.0.0.1',
        port: Number(env.MYSQL_PORT || 3306),
        user: env.MYSQL_USER || 'root',
        password: env.MYSQL_PASSWORD || '',
        database: env.MYSQL_DATABASE || 'ai_tools',
        waitForConnections: true,
        connectionLimit: 5
      });

  /**
   * WHERE 条件与参数。这里是 sql 版和内存版**语义最可能分叉**的地方：
   * 为了让「关键词匹配」与 core/normalize 的 matchesKeyword 等价，
   * 这里也把 name / description / 全部标签拼成一个串再做包含匹配（CONCAT_WS），
   * 而不是逐字段 OR LIKE —— 两者不等价，拼串能命中跨字段的巧合。
   */
  function buildWhere({ q, tag }) {
    const conds = [`t.enabled = 1`];
    const params = [];

    if (tag) {
      conds.push(`EXISTS (SELECT 1 FROM ${TAGS_TABLE} ft WHERE ft.tool_id = t.id AND ft.tag = ?)`);
      params.push(tag);
    }
    if (q) {
      conds.push(
        `CONCAT_WS(' ', t.name, IFNULL(t.description, ''), IFNULL((
            SELECT GROUP_CONCAT(gt.tag) FROM ${TAGS_TABLE} gt WHERE gt.tool_id = t.id
         ), '')) LIKE ? ESCAPE '\\\\'`
      );
      params.push('%' + escapeLike(q) + '%');
    }
    return { sql: conds.join(' AND '), params };
  }

  const rowColumns = `
    t.id, t.name, t.description, t.icon, t.url, t.enabled, t.likes, t.sort_order`;

  /** 数据库一行 → 原始记录（再交给 core 的 normalizeTool，归一化不分叉） */
  function rowToRaw(row, tags) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      tags,
      icon: row.icon,
      url: row.url,
      enabled: row.enabled === 1 || row.enabled === true,
      likes: row.likes,
      order: row.sort_order
    };
  }

  /** 取一批 id 的标签。单独查而不是 GROUP_CONCAT，是为了避免标签里含分隔符时被拆错 */
  async function tagsOf(conn, ids) {
    if (!ids.length) return new Map();
    const [rows] = await conn.query(
      `SELECT tool_id, tag FROM ${TAGS_TABLE} WHERE tool_id IN (?) ORDER BY tag ASC`,
      [ids]
    );
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.tool_id)) map.set(row.tool_id, []);
      map.get(row.tool_id).push(row.tag);
    }
    return map;
  }

  /** 把数据库错误统一转成「数据源不可用」，外壳据此返回 500 而不是崩掉 */
  async function guard(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.code === 'DATA_SOURCE_UNAVAILABLE') throw err;
      throw dataSourceUnavailable(`MySQL 查询失败：${err.code || err.message}`, err);
    }
  }

  return {
    name: 'mysql',
    describe: env.MYSQL_URL ? 'MYSQL_URL' : `${env.MYSQL_HOST || '127.0.0.1'}:${env.MYSQL_PORT || 3306}/${env.MYSQL_DATABASE || 'ai_tools'}`,

    async list({ q, tag, page, pageSize }) {
      return guard(async () => {
        const where = buildWhere({ q, tag });
        const offset = (page - 1) * pageSize;

        // LIMIT / OFFSET 用 query() 的占位符传数字（page/pageSize 已在 shell 校验为整数）
        const [rows] = await pool.query(
          `SELECT ${rowColumns} FROM ${TOOLS_TABLE} t
            WHERE ${where.sql}
            ORDER BY t.sort_order ASC, t.id ASC
            LIMIT ? OFFSET ?`,
          [...where.params, pageSize, offset]
        );

        const [[{ total }]] = await pool.query(
          `SELECT COUNT(*) AS total FROM ${TOOLS_TABLE} t WHERE ${where.sql}`,
          where.params
        );
        const [[{ totalAll }]] = await pool.query(
          `SELECT COUNT(*) AS totalAll FROM ${TOOLS_TABLE} WHERE enabled = 1`
        );

        const tagMap = await tagsOf(pool, rows.map(r => r.id));
        const items = rows
          .map(row => normalizeTool(rowToRaw(row, tagMap.get(row.id) || [])))
          .filter(Boolean);

        return {
          items,
          page,
          pageSize,
          total: Number(total),
          totalAll: Number(totalAll),
          hasMore: page * pageSize < Number(total)
        };
      });
    },

    async tags() {
      return guard(async () => {
        const [rows] = await pool.query(
          `SELECT tt.tag AS tag, COUNT(*) AS c
             FROM ${TAGS_TABLE} tt
             JOIN ${TOOLS_TABLE} t ON t.id = tt.tool_id
            WHERE t.enabled = 1
            GROUP BY tt.tag
            ORDER BY c DESC, tt.tag ASC`
        );
        return rows.map(r => r.tag);
      });
    },

    async hot(limit) {
      return guard(async () => {
        // 与 core/normalize 的 compareHot 逐字对应：likes 降序 → order 升序 → id 升序。
        // 次级键不能省：likes 会大量并列（尤其清一色的 0），只按 likes 排的话
        // 同一次查询两次执行都可能给出不同的行 —— 那正是「排序不确定」的另一种写法。
        const [rows] = await pool.query(
          `SELECT ${rowColumns} FROM ${TOOLS_TABLE} t
            WHERE t.enabled = 1
            ORDER BY t.likes DESC, t.sort_order ASC, t.id ASC
            LIMIT ?`,
          [limit]
        );
        const tagMap = await tagsOf(pool, rows.map(r => r.id));
        return rows
          .map(row => normalizeTool(rowToRaw(row, tagMap.get(row.id) || [])))
          .filter(Boolean);
      });
    },

    async close() {
      try {
        await pool.end();
      } catch (err) {
        warnOnce('mysql-close', `[mysql] 关闭连接池时出错（可以忽略）：${err.message}`);
      }
    }
  };
}

module.exports = { create };
