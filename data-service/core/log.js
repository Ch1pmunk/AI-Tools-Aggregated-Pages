/**
 * 极简日志工具。
 *
 * 只为一件事存在：**去重**。数据源每个请求都重新读盘，一个坏掉的记录文件如果每次都打一行，
 * 刷一屏日志的同时还会把真正的错误埋掉。按 key 去重后，同一条问题整个进程只报一次。
 */

const seen = new Set();

/** 同一个 key 只打一次 */
function warnOnce(key, message) {
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(message);
}

/** 测试与排障用：清掉去重记录，让警告能再报一次 */
function resetLogDedup() {
  seen.clear();
}

module.exports = { warnOnce, resetLogDedup };
