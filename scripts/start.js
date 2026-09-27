/**
 * 一条命令起两个服务：静态页 + 数据服务。
 * ---------------------------------------------------------------------------
 *   node scripts/start.js          或     npm start
 *
 * 存在的理由只有一个：**端口只在一处配**。
 * 静态服务要告诉浏览器「数据服务在哪个地址」（页面靠它取数），
 * 这个地址由本文件从 DATA_HOST / DATA_PORT 推出来再传给静态服务，
 * 所以改数据服务的端口只需要改一个环境变量，两个服务一起跟上，
 * 不会出现「数据服务搬走了、页面还在敲老地址」。
 *
 *   DATA_PORT=4001 npm start      → 数据服务在 4001，页面也知道去 4001
 *   PORT=8080 npm start           → 静态页在 8080
 *
 * 单独启动的能力完整保留（npm run start:static / npm run start:data）——
 * 本文件只是把两件事按正确顺序拼起来，不做任何别的加工。
 * ---------------------------------------------------------------------------
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || '3000';
const DATA_HOST = process.env.DATA_HOST || '127.0.0.1';
const DATA_PORT = process.env.DATA_PORT || '3001';

/**
 * 监听地址 → 浏览器该访问的地址。
 * 绑 0.0.0.0 是「监听所有网卡」，不是「访问 0.0.0.0」，照原样写进页脚和地址栏都是错的。
 */
function browserHost(host) {
  return (host === '0.0.0.0' || host === '::') ? '127.0.0.1' : host;
}

// 页面该去哪个地址取数据。显式设了 DATA_ORIGIN 就听它的（比如数据服务在另一台机器上）
const DATA_ORIGIN = process.env.DATA_ORIGIN || `http://${browserHost(DATA_HOST)}:${DATA_PORT}`;

const children = [];
let shuttingDown = false;

function startService(label, scriptPath, extraEnv) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: ROOT,
    env: Object.assign({}, process.env, extraEnv),
    stdio: 'inherit'   // 两个服务的日志都直接打在同一个终端里，不加前缀、不重定向
  });
  child.__label = label;
  children.push(child);

  child.on('error', (err) => {
    console.error(`[${label}] 起不来：${err.message}`);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    // 任何一个倒下，另一个留着也没用：页面没有数据，或者数据没人看
    console.error(`\n[${label}] 已退出（${signal || 'code ' + code}），正在停掉另一个服务。`);
    shutdown(code === 0 ? 0 : (code || 1));
  });

  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        // Windows 上 Node 用 TerminateProcess 模拟 SIGTERM：子进程跑不到自己的
        // server.close()，但进程一死端口就由操作系统释放，本地开发够用。
        // 在类 Unix 上这是真正的 SIGTERM，子进程的优雅退出逻辑会正常走完。
        child.kill('SIGTERM');
      } catch (err) { /* 已经没了 */ }
    }
  }

  // 给子进程一点时间自己收尾；到点还在就直接退，不留孤儿
  const timer = setTimeout(() => process.exit(code), 500);
  Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
  }))).then(() => {
    clearTimeout(timer);
    process.exit(code);
  });
}

process.on('SIGINT', () => { console.log('\n收到 Ctrl+C，正在停止两个服务……'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));

/* --------------------------------- 启动 --------------------------------- */

console.log(`静态页    http://${browserHost(HOST)}:${PORT}`);
console.log(`数据服务  ${DATA_ORIGIN}   ← 由 DATA_HOST / DATA_PORT 推导，页面也会拿到这个地址`);
console.log('');
// 关掉窗口就停 —— 这件事由操作系统保证（两个子进程共用本控制台，窗口一关全被收掉），
// 不是本脚本做到的。所以这里只说明，不假装是自己干的。
console.log('关掉这个窗口、或按 Ctrl+C，两个服务会一起停。\n');

// 先起数据服务，再起静态页。顺序其实无所谓（页面加载时才去取数），
// 但日志按这个顺序读起来更顺：先知道数据从哪来，再知道页面在哪。
startService('data-service', path.join('data-service', 'server.js'), {
  DATA_HOST, DATA_PORT
});

startService('static-server', path.join('server.js'), {
  HOST, PORT, DATA_ORIGIN
});
