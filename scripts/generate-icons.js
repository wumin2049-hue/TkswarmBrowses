#!/usr/bin/env node
/**
 * 从 build/icon.svg 生成 icon.png / icon.ico（Windows exe + NSIS 安装器）
 * NSIS 仅接受标准 ICO 尺寸（16/32/48/256），不可包含 512。
 * 用法：npm run icons
 *
 * CI 兜底：icon.png / icon.ico 已入库时，若 sharp 未安装则跳过重生，避免打包失败。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const svgPath = path.join(buildDir, 'icon.svg');
const pngPath = path.join(buildDir, 'icon.png');
const icoPath = path.join(buildDir, 'icon.ico');

/** NSIS / electron-builder 兼容的 ICO 尺寸 */
const ICO_SIZES = [16, 32, 48, 256];

function hasCommittedIcons() {
  return fs.existsSync(pngPath) && fs.existsSync(icoPath);
}

function loadIconDeps() {
  try {
    const sharp = require('sharp');
    const pngToIco = require('png-to-ico').default || require('png-to-ico');
    return { sharp, pngToIco };
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && hasCommittedIcons()) {
      console.warn(
        `[icons] 缺少依赖 ${error.message}；已存在 build/icon.png 与 build/icon.ico，跳过重新生成`
      );
      return null;
    }
    throw error;
  }
}

async function main() {
  const deps = loadIconDeps();
  if (!deps) return;

  if (!fs.existsSync(svgPath)) {
    console.error('缺少 build/icon.svg');
    process.exit(1);
  }

  const { sharp, pngToIco } = deps;
  const svg = fs.readFileSync(svgPath);

  await sharp(svg).resize(512, 512).png().toFile(pngPath);

  const pngPaths = [];
  for (const size of ICO_SIZES) {
    const out = path.join(buildDir, `icon-${size}.png`);
    await sharp(svg).resize(size, size).png().toFile(out);
    pngPaths.push(out);
  }

  const icoBuf = await pngToIco(pngPaths);
  fs.writeFileSync(icoPath, icoBuf);

  for (const p of pngPaths) {
    if (p !== path.join(buildDir, 'icon-256.png')) {
      fs.unlinkSync(p);
    }
  }

  console.log('已生成:');
  console.log(' -', pngPath);
  console.log(' -', path.join(buildDir, 'icon-256.png'));
  console.log(' -', icoPath, `(${ICO_SIZES.join('/')})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
