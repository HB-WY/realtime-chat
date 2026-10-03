// plugins-demo/pack-plugin.mjs
//
// 通用插件打包脚本：把一个**项目目录**打包成 <id>.plugin（JSON 格式）。
//
// 与旧的单文件打包脚本的区别：
//   · 递归收集目录下所有文件，保留目录结构（lib/host.js、pages/chat/index.css …）
//   · manifest.json 单独读（不进 files 字段）
//   · 校验：manifest 存在 / id 与目录名一致 / entry 存在于 files / pages 全部存在
//   · 忽略开发期文件（node_modules、.git、*.tmp、*.log 等）
//
// 用法：
//   node pack-plugin.mjs                 # 打包所有含 manifest.json 的子目录
//   node pack-plugin.mjs ai-chat         # 只打包 ai-chat
//   node pack-plugin.mjs ai-chat other   # 打包多个
//
// 输出：<id>.plugin 到当前目录（plugins-demo/）
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 与 server/src/services/plugins.js 的 CFG 保持一致
const MAX_FILE_BYTES = 1024 * 1024;         // 1MB / 文件
const MAX_FILES = 100;

// 忽略的系统 / 隐藏目录
const IGNORE_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
  '.DS_Store', 'Thumbs.db', '.idea', '.vscode'
]);
const IGNORE_SUFFIXES = ['.swp', '.swx', '.tmp', '.log', '~'];

function shouldIgnore(name) {
  if (IGNORE_NAMES.has(name)) return true;
  if (IGNORE_SUFFIXES.some((s) => name.endsWith(s))) return true;
  return false;
}

/**
 * 递归收集目录下的所有文件（不含 manifest.json）。
 * @returns {Object<string, string>}  { 'pages/chat/index.html': '<html>...', 'lib/host.js': '...' }
 */
function collectFiles(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (shouldIgnore(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      collectFiles(abs, base, out);
    } else if (e.isFile()) {
      // manifest.json 单独处理，不进 files
      const rel = path.relative(base, abs).split(path.sep).join('/');
      if (rel === 'manifest.json') continue;
      out[rel] = fs.readFileSync(abs, 'utf8');
    }
  }
  return out;
}

function buildOne(id) {
  const srcDir = path.join(HERE, id);
  if (!fs.existsSync(srcDir)) throw new Error(`找不到插件目录：${srcDir}`);

  const manifestPath = path.join(srcDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`缺少 manifest.json：${srcDir}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // 基础校验
  if (!manifest.id || manifest.id !== id) {
    throw new Error(`manifest.id「${manifest.id}」与目录名「${id}」不一致`);
  }
  if (!manifest.entry) throw new Error('manifest 缺少 entry');
  if (!manifest.version) throw new Error('manifest 缺少 version');

  const files = collectFiles(srcDir);

  // entry 必须在 files 里
  const entryRel = String(manifest.entry).replace(/^\.?\//, '');
  if (!(entryRel in files)) {
    throw new Error(`manifest.entry「${manifest.entry}」不在打包文件里`);
  }

  // pages（可选）：每个页面都必须在 files 里
  if (Array.isArray(manifest.pages) && manifest.pages.length > 0) {
    for (const p of manifest.pages) {
      const pp = typeof p === 'string' ? p : (p && p.path);
      if (!pp) throw new Error('manifest.pages 里有一项缺少 path');
      const rel = String(pp).replace(/^\.?\//, '');
      if (!(rel in files)) {
        throw new Error(`manifest.pages 里的「${pp}」不在打包文件里`);
      }
    }
  }

  if (Object.keys(files).length === 0) {
    throw new Error(`目录里没有可打包的文件：${srcDir}`);
  }
  if (Object.keys(files).length > MAX_FILES) {
    throw new Error(`文件数超限：${Object.keys(files).length} > ${MAX_FILES}`);
  }

  // 逐文件检查大小
  for (const [rel, content] of Object.entries(files)) {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(
        `文件过大：${rel}（${(bytes / 1024).toFixed(1)}KB，上限 ${MAX_FILE_BYTES / 1024}KB）`
      );
    }
  }

  const bundle = { manifest, files };
  const outPath = path.join(HERE, `${id}.plugin`);
  fs.writeFileSync(outPath, JSON.stringify(bundle), 'utf8');

  const size = fs.statSync(outPath).size;
  const fileCount = Object.keys(files).length;
  console.log(
    `✓ ${id}.plugin  (${(size / 1024).toFixed(1)} KB, ${fileCount} 个文件, v${manifest.version})`
  );

  // 展示文件清单（超过 12 个只列前 12 + "...")
  const list = Object.keys(files).sort();
  for (const f of list.slice(0, 12)) console.log(`    · ${f}`);
  if (list.length > 12) console.log(`    · ...以及另外 ${list.length - 12} 个文件`);

  return outPath;
}

const args = process.argv.slice(2);
const targets = args.length > 0
  ? args
  : fs.readdirSync(HERE, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(HERE, e.name, 'manifest.json')))
      .map((e) => e.name);

if (targets.length === 0) {
  console.error('没有找到任何插件目录（需要含 manifest.json 的子目录）');
  process.exit(1);
}

let ok = 0;
for (const id of targets) {
  try {
    buildOne(id);
    ok += 1;
  } catch (err) {
    console.error(`✗ ${id}: ${err.message}`);
  }
}

console.log(`\n打包完成：${ok}/${targets.length}`);
process.exit(ok === targets.length ? 0 : 1);