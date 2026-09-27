# 数据源适配器

一个适配器只回答一个问题：**「怎么把原始记录读出来」**。
归一化、`enabled` 过滤、匹配、排序、分页**一律不在这里**，全在 `core/`（见 `architecture.md` 第二节）。

---

## 一、契约

```js
{
  name: string,                          // 显示在启动日志和 /api/health 里
  async list({ q, tag, page, pageSize }) // → { items, page, pageSize, total, hasMore, totalAll }
  async tags()                           // → string[]（用得多在前，同次数按字典序升序）
  async hot(limit)                       // → 记录数组（likes 降序 → order 升序 → id 升序，取前 limit）
  async close()?                         // 可选，进程退出时调用（连接池用）
}
```

硬约束：

1. 返回的必须是**已归一化、且 `enabled !== false`** 的记录。`tags()` 与两个计数同理 ——
   不能一边把某条记录筛掉、一边还把它算进分类里。
2. **不许在适配器里重写一份归一化 / 匹配 / 排序 / 分页。** 这是唯一会让
   「换个数据源结果就变了」的原因，而且极难发现。
3. 抛错就抛错，**适配器自己不写 HTTP 状态码、不拼错误响应**。外壳统一转成 500。
   抛 `dataSourceUnavailable(原因)`（来自 `core/memory-source.js`）会得到
   `code: DATA_SOURCE_UNAVAILABLE`，页面据此进入「不知道有几条」的失败态。
4. 排序必须是**确定的**（`order` 升序、同 `order` 按 `id` 升序）。顺序不确定 = 分页会重复和漏项。
5. **适配器只读。** 契约里没有 `write` / `increment` / `update` 之类的方法，
   实现里也不许出现写盘或写库的语句。`likes` 因此是静态值：
   没有任何入口能让访客改它 —— 一个也没有，这是硬性的（见 `../Readme.md` 第八节「只读」）。

`core/memory-adapter.js` 是**语义基准实现**。文件类适配器都是「读盘 → 交给它」，
彼此只差读盘那一步。

---

## 二、四个适配器

| `DATA_SOURCE` | 读什么 | 配置 | 什么时候用 |
|---|---|---|---|
| `json-dir`（默认） | 一个目录下的 `*.json`，一文件一条记录 | `DATA_DIR`（默认 `catalog`） | 默认。增删工具 = 增删文件 |
| `json-file` | 单个 `.json`，内容是数组 | `DATA_FILE` | 目录还没组织好，先塞一个文件 |
| `js-file` | 单个 `.js`，导出数组或 `{tools: [...]}` | `DATA_FILE` | 同上，想在里面写注释/复用变量时 |
| `mysql` | `tools` + `tool_tags` 两张表 | `MYSQL_URL` 或分项 | 记录多到文件不好管的时候 |

未知的 `DATA_SOURCE` 会在**启动时**当场报错并列出可选值，不会等到第一个请求才 500。

**默认值是源码里的一行，不是隐形的约定。** 上表那两个「默认」各对应一处 ★ 标记：

| 想改什么 | 改哪里 |
|---|---|
| 用哪个适配器 | `core/resolve.js` 的 `DEFAULT_SOURCE`（现在是 `json-dir`） |
| 清单文件放在哪 | `adapters/json-dir.js` 的 `DEFAULT_DIR`（现在是 `catalog`） |

**搜 `★` 就能找到这两行。** 环境变量 `DATA_SOURCE` / `DATA_DIR` 优先级高于它们，
所以「临时用一次 MySQL」不必动源码，「以后就用 MySQL」才改那一行。

### `json-dir` 的几条行为

- 跳过非 `.json`，跳过 `.` 与 `_` 开头的文件（所以 `catalog/_template.json` 不会被当成工具）
- 文件名排序后逐个读，**每个文件单独 try/catch** —— 一个文件坏了只丢那一条，其余照常 200
- **`id` 的权威来源是记录里的 `id` 字段，不是文件名**；两者不一致会打一条警告
- **每个请求重新读盘，不缓存。** 「改完 `catalog/` 立即生效、不用重启」是这个项目
  运维体验的核心。目录里文件上千了再加 mtime 缓存 —— 接口不变，加在适配器里就行

---

## 三、接 MySQL：步骤与验证清单

> ⚠️ **`mysql.js` 是完整实现，但本机没有 MySQL 实例，一个字都没实测过。**
> 下面这张清单就是「没验过」这件事的补偿 —— **接入前逐条验完，验不过就别切过去。**

### 步骤

```bash
# 1. 装驱动。本项目其余部分零依赖，所以 mysql2 不写进 package.json 的 dependencies ——
#    不用 MySQL 的人不必装它。
npm i mysql2

# 2. 建库建表
mysql -u root -p -e "CREATE DATABASE ai_tools CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p ai_tools < data-service/adapters/schema.sql

# 3. 切数据源
DATA_SOURCE=mysql MYSQL_URL='mysql://root:密码@127.0.0.1:3306/ai_tools' npm start

# 4. 自检
curl -s localhost:3001/api/health
```

### 验证清单

| # | 验什么 | 怎么验 | 为什么 |
|---|---|---|---|
| 1 | mysql2 装得上；**没装**时给的是中文指引 | 不装就 `DATA_SOURCE=mysql node data-service/server.js` | 应该看到「请执行：npm i mysql2」，而不是 `MODULE_NOT_FOUND` |
| 2 | 库和表都是 **utf8mb4** | `SELECT @@character_set_database;` / `SHOW CREATE TABLE tools;` | `icon` 存的是 emoji。老的 utf8 是三字节，会把 emoji 存成 `?` |
| 3 | `schema.sql` 执行成功，两张表都在 | `SHOW TABLES;` | — |
| 4 | 关键词里的 `%` 和 `_` **不当通配符** | `curl '.../api/tools?q=%25'` → `total: 0` | 不转义的话，搜一个 `%` 会匹配到全部。`escapeLike()` 负责转义 |
| 5 | `LIMIT` / `OFFSET` 用占位符 | 读 `mysql.js`，确认没有字符串拼接 | SQL 注入 |
| 6 | `total` 与 `totalAll` 的差异符合预期 | 带 `tag=` 查一次，对比两个数 | 前者是筛选后，后者是全部 enabled |
| 7 | 空库不报错 | 清空表后 `curl .../api/tools` | 应返回 `{items: [], total: 0, hasMore: false}`，不是 500 |
| 8 | 退出时连接池被关掉 | `Ctrl+C` 后看进程是否干净退出 | `close()` 由外壳在退出时调用 |
| 9 | **与 json 版对拍** | 见下 | 这是发现语义分叉的**唯一**手段 |

### 对拍（第 9 条，最重要）

同一批数据分别灌进 `catalog/*.json` 和 MySQL，然后逐个用例比较两个数据源的输出。
把两个服务的响应 diff 一遍即可：

```bash
# 起一份 json-dir（3001）和一份 mysql（4001），同一批数据
for qs in '' 'q=办公' 'q=%25' 'q=TOOL' 'tag=办公' 'tag=办公&q=tool01' \
          'page=1&pageSize=12' 'page=3&pageSize=12' 'page=99&pageSize=12'; do
  A=$(curl -s "localhost:3001/api/tools?$qs" | tr -d ' \n')
  B=$(curl -s "localhost:4001/api/tools?$qs" | tr -d ' \n')
  [ "$A" = "$B" ] && echo "OK   $qs" || { echo "分叉 $qs"; echo "  json : $A"; echo "  mysql: $B"; }
done
```

`items` 的**顺序**也必须一致 —— 只比条数不够。顺序不一致说明排序在下推成 SQL 时漏了
`id` 这个次级键，而排序不确定正是分页会重复/漏项的根因。

其余端点同理：`/api/tags`（顺序！）和 `/api/hot`（顺序，且要**连 `likes` 一起对**）。

`/api/hot` 的对拍要多准备一步：数据里必须有**点赞数并列**的记录（比如三条都是 `likes: 0`），
否则看不出次级键有没有漏。漏了的表现不是报错，而是「首页那 6 张卡换了人」——
同一批数据两次请求给出不同的结果。

### 唯一允许分叉的地方

过滤、排序、分页在 mysql 版里由 SQL 做 —— 不这么做就得把整表读进内存，那数据库就白用了。
归一化仍然走 `core/normalize.js`，**没有分叉**。

所以 `mysql.js` 里那几条 SQL 的 `WHERE` / `ORDER BY` 是在用另一种语言复述
`core/normalize.js` 的语义。**改了 `normalize.js` 的匹配或排序规则，必须同步改 `mysql.js`
并重跑对拍。**
