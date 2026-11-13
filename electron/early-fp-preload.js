/**
 * 内容页 session 级 preload：在每个文档的页面脚本执行之前，同步把指纹覆盖脚本注入主世界。
 *
 * 背景：Page.addScriptToEvaluateOnNewDocument 要等 did-start-navigation 之后才异步下发，
 * 实测首个文档的页面脚本会先读到真实值（Intel 显卡 / deviceMemory=16 / 通知权限 granted）。
 * preload 在文档创建时运行，早于任何页面脚本。
 * 注入脚本自带 Symbol 守卫，与 CDP 注入重复执行无副作用。
 */
const { ipcRenderer, webFrame } = require('electron');

try {
  const src = ipcRenderer.sendSync('tkswarm:early-fp');
  if (typeof src === 'string' && src) {
    webFrame.executeJavaScript(src).catch(() => {});
  }
} catch (e) { /* 不影响页面加载 */ }
