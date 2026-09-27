# data-service/ —— 数据服务

一个独立进程、独立端口（默认 `127.0.0.1:3001`）。**它只发数据，不发页面。**

存在的理由只有一条：**让「换数据源」这件事被关在这一个目录里。**
页面怎么渲染、静态服务怎么发文件，都不该因为「记录从文件换成 MySQL」而改动一个字。

启动：`npm run start:data`，或随 `npm start` 一起起来（推荐，见 `../scripts/README.md`）。

---

## 一、目录结构：core 与 adapters 的分工

这是本目录**最重要的一条规矩**：

> **语义住 `core/`，不住适配器。**
> 适配器只回答一个问题：**「怎么把原始记录读出来」。**

```
data-service/
├─ server.js              HTTP 外壳：路由、CORS、参数校验、统一 JSON 错误
├─ core/                  ★ 语义层 —— 归一化 / 过滤 / 匹配 / 排序 / 分页 / 出站投影
│  ├─ contract.js         常量（默认值、上限）+ 记录形状的说明
│  ├─ normalize.js        ★ 语义唯一出处：normalizeTool / safeUrl / matchesKeyword
│  │                        / compareTools / compareHot / applyFilters / paginate / toPublic
│  ├─ memory-adapter.js   ★ 语义基准实现：拿一批记录，提供 list / tags / hot
│  ├─ memory-source.js    「每次请求重新读一遍」的包装器 + dataSourceUnavailable()
│  ├─ resolve.js          ★ DEFAULT_SOURCE：默认用哪个适配器（改这一行就换数据源）
│  └─ log.js              日志去重（warnOnce）
└─ adapters/              只管读盘 / 查询
   ├─ json-dir.js         一个目录下的 *.json        ← 默认，读 ../catalog/
   │                        （★ DEFAULT_DIR：清单文件放哪，改这一行）
   ├─ json-file.js        单个 .json（内容是数组）
   ├─ js-file.js          单个 .js（导出数组）
   ├─ mysql.js            tools + tool_tags 两张表   ← 完整但**未实测**
   └─ schema.sql          MySQL 建表脚本
```

**为什么这条规矩这么要紧**：如果每个适配器各写一份匹配和排序，json 版和 mysql 版迟早会
不一致 —— 而这种不一致极难发现，表现是「同一份数据换了个数据源，结果就不一样了」，
而且往往过很久才有人注意到。

三个文件类适配器（`json-dir` / `json-file` / `js-file`）都是「读出来 → 交给 memory 引擎」，
彼此只差读盘那一步，语义**不可能**分叉。

唯一允许分叉的是 `mysql.js`：它把过滤 / 排序 / 分页下推成 SQL（否则要把整表读进内存，
那就白用数据库了）。所以它必须拿 json 版**对拍**，用例见 `../docs/adapters.md`。

---

## 二、一次请求经过什么

```
GET /api/tools?q=办公&page=2
   │
   ▼ server.js         解析 URL、校验参数（非法直接 400，不静默兜底）、CORS
   ▼ core/resolve.js   按 DATA_SOURCE 拿适配器（启动时就选好，不是一个请求选一次）
   ▼ adapters/json-dir 读 ../catalog/*.json —— **每个请求重新读，不缓存**
   ▼ core/memory-adapter.js
        normalizeAll → 丢掉坏记录与重复 id → 只留 enabled → 按 order/id 排序
        applyFilters → paginate
   ▼ core/normalize.js toPublic()  ← 出站白名单：enabled 等内部字段到此为止
   ▼ JSON 响应          { items, page, pageSize, total, totalAll, hasMore }
```

「每个请求重新读盘」是刻意的：**改完 `catalog/` 立即生效、不用重启**，这是这个项目
运维体验的核心。目录里文件上千了再加 mtime 缓存 —— 接口不变，加在适配器里就行。

---

## 三、和谁配合

| 谁 | 怎么配合 |
| --- | --- |
| `../server.js`（静态服务） | **互不连接。** 它只是把本服务的地址通过 `/api/config` 的 `data.origin` 告诉浏览器 |
| `../assets/js/api.js` | 页面唯一的取数通道。地址按四级优先级解析，不写死 |
| `../catalog/` | `json-dir` 适配器的 `DATA_DIR`（默认值）。换成 MySQL 后就不再读它 |
| `../docs/data-contract.md` | **前后端唯一契约**。改端点必须同时改那份文档和 `core/contract.js` |

两个服务分开，是为了让「换数据库」不必动那个同时管着页面的进程。
也正因为分开，本服务搬到别的机器、换成 MySQL、中间加一层代理，页面代码都不用动。

---

## 四、配置

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DATA_HOST` / `DATA_PORT` | `127.0.0.1` / `3001` | 监听地址 |
| `CORS_ORIGIN` | 未设 → `*` | 逗号分隔的来源白名单 |
| `DATA_SOURCE` | `json-dir` | `json-dir` / `json-file` / `js-file` / `mysql` |
| `DATA_DIR` / `DATA_FILE` | `../catalog` / — | 各适配器的数据位置 |
| `MYSQL_URL` 或分项 | 空 | 见 `adapters/mysql.js` |

「默认值」不是散在环境变量里的 —— 表里那两个默认值**在源码里各有一行**，
用 ★ 标出来了（`core/resolve.js` 的 `DEFAULT_SOURCE`、`adapters/json-dir.js` 的 `DEFAULT_DIR`）。
不设环境变量时用的就是它们，想改默认行为直接改那两行，**搜 `★` 就能找到**；
环境变量优先级更高，跑临时组合时不必动源码。

端口不写死：`npm start` 会按 `DATA_HOST`/`DATA_PORT` 把地址算好传给静态服务，
所以 `DATA_PORT=4001 npm start` 改一处，两个服务一起跟上。

**默认 CORS `*` 不算「写死」** —— 它不含任何主机名和端口，恰恰是「不写死」的表达。
本服务无 Cookie、无凭据、只发只读数据，规范上完全合法。

---

## 五、只读

**本服务没有任何写入接口，一个都没有。** 除 `GET` / `HEAD` 外一律 `405`
（`OPTIONS` 只用来兜底 CORS）；`server.js` 里没有收请求体的分支，整个 `data-service/`
里没有一处 `fs.write*`。

这条是硬性的，不是「还没来得及做」：记录（含 `likes`）只能由维护者在**本机**增删改文件。
将来做点赞是一套单独设计的东西（谁能改、怎么防刷、要不要校验来源），
在那套设计定下来之前不放宽任何一条。见 `../Readme.md` 第八节「只读」。

---

## 六、改动之前请先读

- 改**记录形状或端点** → `core/contract.js` + `../docs/data-contract.md`，两处一起改，
  再改 `../Readme.md` 对应节。
- 改**匹配或排序规则** → `core/normalize.js`，然后**重跑 `../docs/adapters.md` 里的对拍**：
  `mysql.js` 里那几条 SQL 是在用另一种语言复述同一套语义，不同步改就会分叉。
- 加**新数据源** → 在 `adapters/` 下加一个文件，`core/resolve.js` 里登记一行。
  加之前先读 `../docs/adapters.md` 的适配器契约（四条硬约束）。

`mysql.js` 是完整实现但**一个字都没实测过**（作者本机没有 MySQL 实例）。
接入前逐条验完 `../docs/adapters.md` 的验证清单，验不过就别切过去。
