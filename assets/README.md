# assets/ —— 前端资源

浏览器真正下载并执行的东西。**没有任何构建步骤**：这里的文件就是最终产物，
改完刷新页面即生效（`server.js` 对 `.html` / `.js` / `.css` 发 `no-cache`，不会拿到旧文件）。

```
assets/
├─ css/site.css    组件级样式 + 设计令牌（:root 变量）
└─ js/             ES module，六个文件，单向依赖
```

---

## 一、这个目录和谁配合

```
index.html            只有结构、文案、tailwind.config —— **不含任何数据、任何业务逻辑**
   │   <script type="module" src="/assets/js/main.js">
   ▼
assets/js/main.js     唯一入口：绑事件 + 第一次渲染
   │   main → router → views → { ui, pager, api }
   ▼
数据服务 :3001        页面只通过 api.js 与它说话（地址由 api.js 解析，见下）
server.js :3000       把这些文件按白名单发给浏览器
```

样式分两处，**改色板必须同时改两处**：

| 在哪 | 给谁用 | 为什么分不开 |
| --- | --- | --- |
| `index.html` 里的 `tailwind.config` | Tailwind Play CDN 运行时读它，生成 `bg-cream` 这类工具类 | CDN 拿到的是配置对象，读不到 CSS 变量 |
| `assets/css/site.css` 顶部的 `:root` | 手写的组件级 CSS 读它 | 手写 CSS 里不该散落魔法色值 |

---

## 二、六个 js 文件分别管什么

| 文件 | 管什么 | 改这里的典型场景 |
| --- | --- | --- |
| `ui.js` | 展示层：`esc` / toast / 卡片模板（**三个视图共用**，含 `likesHtml` 那个右下角点赞数）/ 空状态 / 失败态 / **文案常量**（含「本地副本未就位」角标） | 改卡片长什么样、改状态行措辞、改点赞数的画法 |
| `pager.js` | 分批加载：按页取数 + 竞态令牌 + 空页保险 + 渲染下限 | 改页大小、改触底行为 |
| `api.js` | **唯一通道**：数据服务地址解析 + fetch + 超时 + 错误归一化 + 本地副本探查（`isSitePath` / `probeLocalProject`） | 改取数逻辑、加接口、调超时上限 |
| `views.js` | 三个视图各自的渲染；状态由参数传入，不读全局；渲染后探一遍本地副本（`probeLocalCards`） | 改某个页面的结构 |
| `router.js` | 应用状态与路由：地址栏 ↔ 状态、视图切换、重试分发、点卡片的三种分流（`openTool`） | 加页面、改地址栏规则 |
| `main.js` | 唯一入口：事件绑定 + 第一次渲染 | 加事件委托 |

「本地副本探查」这个功能横跨三个文件，但每一层的职责是分开的：`api.js` **只负责问**
（问出 true / false / null 三种答案），`views.js` **只负责把答案写到卡片上**，
`router.js` **只负责按答案分流**。要改探查行为，先想清楚改的是哪一层。

依赖方向是**单向**的（`main → router → views → {ui, pager, api}`）。
`views.js` 不 import `router.js`，所以不会绕成循环 import —— 加东西时请守住这条。

---

## 三、几个不这么做就会出事的细节

这几条都在代码注释里写了理由，改代码前先读：

- **`src` 必须写绝对路径** `/assets/js/main.js`。写相对路径时，在 `/tools` 页面下会被解析成
  `/tools/assets/js/main.js` → 404，而报错不会指向根因。
- **模块之间的 `import` 必须带 `.js` 扩展名**：浏览器 ESM 不做扩展名补全。
- **`package.json` 里故意没有 `type` 字段**。这里的文件是**浏览器**的 ES module，
  而 `package.json` 管的是 Node 怎么解析 `.js`。写 `commonjs`，Node 会把 `assets/js/*.js`
  也按 CommonJS 解析 → 「用 Node 直接 import 一个前端模块来验一段逻辑」这条路直接报语法错；
  写 `module` 则服务端那堆 `require` 全崩。不写，Node 靠自动探测，代价只是 ad-hoc 跑前端模块时
  打一句 `MODULE_TYPELESS_PACKAGE_JSON` 警告。**一句警告换一条能用的验证路径，划算** ——
  这个项目零依赖、没有测试框架，用 Node 直接跑模块是唯一能自动验一段逻辑的办法。
- **`fetchConfig()` 有两层缓存（在途合并 + 成功缓存），不要拆**。页脚（`main.js`）和
  取数前的地址解析（`api.js`）都要问 `/api/config`，两处几乎同时发起，而请求带的是
  `cache: 'no-store'` —— 浏览器不会替我们合并，拆掉缓存就是一次加载发两遍请求（量过）。
  失败**不留缓存**，否则重试按钮会变成摆设。
- **`window.open()` 必须在用户手势的同步调用栈里**。所以卡片把 `url` / `name` 写在
  `data-tool-url` / `data-tool-name` 上，点击时直接读 —— 一旦中间 `await` 过，弹窗会被拦掉。
  这条同时决定了「本地副本在不在」**只能在渲染后探、不能点击时探**（探的结果写在
  `data-tool-local` 上，点击时同步读）。
- **所有出站请求都要走 `fetchWithTimeout`**，一个都不能漏。漏掉的那个就是页面永远卡住的那条路：
  服务**被关掉**是秒失败（`ECONNREFUSED`），服务**卡住**不是 —— 没有超时，页面就停在
  「正在加载工具……」，既不报错也不长重试按钮。超时一响，请求被中止，**对面后来才回的响应
  根本到不了页面**，这才是「丢掉超时的返回」的落地方式（不是靠调用方记得判断）。
- **URL 由服务端白名单过滤**（`data-service/core/normalize.js` 的 `safeUrl`），
  前端不做二次判断，也不该把没过滤的值拼进 `href`。
- **数据不可用时不画任何卡片、不显示任何计数** —— 详见 `Readme.md` 第九节那张对照表。
  这是硬要求，不是风格偏好。

---

## 四、`index.html` 为什么留在根目录

它是页面的入口，也是「打开这个目录就是那个静态页」的那个文件；
`Readme.md` 第十节里那条备选命令（`python3 -m http.server`）也依赖它在根目录。

它里面**只有**结构、文案和 `tailwind.config`。看到数据、看到业务判断，就是放错了地方 ——
那些属于 `data-service/` 和 `assets/js/`。
