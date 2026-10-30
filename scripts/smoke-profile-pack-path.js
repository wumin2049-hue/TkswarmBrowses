/**
 * 验证环境包导出不依赖「中文绝对路径 + Windows tar」
 * node scripts/smoke-profile-pack-path.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-pack-smoke-'));
const packDir = path.join(root, 'pack');
const chineseExports = path.join(root, 'Tik Tok', '数据目录', 'exports');
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(chineseExports, { recursive: true });
fs.writeFileSync(path.join(packDir, 'meta.json'), JSON.stringify({ format: 'tkswarm-browser-profile' }));
fs.mkdirSync(path.join(packDir, 'userdata'));
fs.writeFileSync(path.join(packDir, 'userdata', 'cookie.txt'), 'ok');

const badAbs = path.join(chineseExports, 'bad.tgz');
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';

const old = spawnSync(tar, ['-czf', badAbs, '-C', packDir, 'meta.json', 'userdata'], {
  encoding: 'utf8',
  windowsHide: true,
});
console.log('[old abs -f] status=', old.status, 'ok=', fs.existsSync(badAbs),
  'stderr=', String(old.stderr || '').slice(0, 200));

// 生产路径：profile-backup.createTgzFromDir（Windows 走 Node）
const { createTgzFromDir } = (() => {
  // 直接测同目录实现：动态 require 真实模块
  try {
    return require('../src/browser/profile-backup');
  } catch (e) {
    console.warn('skip module require:', e.message);
    return {};
  }
})();

if (typeof createTgzFromDir === 'function') {
  const nodeOut = path.join(os.tmpdir(), `tk-smoke-node-${Date.now()}.tgz`);
  const packed = createTgzFromDir(packDir, nodeOut);
  must(fs.existsSync(nodeOut) && fs.statSync(nodeOut).size > 20, 'node/createTgzFromDir failed');
  must(zlib.gunzipSync(fs.readFileSync(nodeOut)).length > 0, 'gzip readable');
  const dest = path.join(chineseExports, 'from-node.tgz');
  fs.copyFileSync(nodeOut, dest);
  must(fs.existsSync(dest), 'copy to chinese exports ok');
  console.log('smoke-profile-pack-path: node via=', packed.via, '→', dest);
  try { fs.unlinkSync(nodeOut); } catch { /* */ }
} else {
  const relName = 'good.tgz';
  const neu = spawnSync(tar, ['-czf', relName, 'meta.json', 'userdata'], {
    encoding: 'utf8',
    cwd: packDir,
    windowsHide: true,
  });
  const relPath = path.join(packDir, relName);
  must(neu.status === 0 && fs.existsSync(relPath), `relative tar failed: ${neu.stderr || neu.status}`);
  const dest = path.join(chineseExports, 'copied.tgz');
  fs.copyFileSync(relPath, dest);
  must(fs.existsSync(dest) && fs.statSync(dest).size > 20, 'copy to chinese exports ok');
  must(zlib.gunzipSync(fs.readFileSync(dest)).length > 0, 'gzip readable');
  console.log('smoke-profile-pack-path: relative tar ok →', dest);
}

console.log('smoke-profile-pack-path: ok');
