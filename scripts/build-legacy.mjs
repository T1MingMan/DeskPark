import { build } from 'esbuild';
import { transformAsync } from '@babel/core';
import { parse } from 'acorn';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = new URL('../apps/web/dist-legacy/', import.meta.url);
// Never empty apps/web/dist, and never write production web/index.html.
await mkdir(out, { recursive: true });
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['apps/web/legacy/main.tsx'],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2018',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: false,
});
const result = await transformAsync(bundle.outputFiles[0].text, {
  babelrc: false,
  configFile: false,
  presets: [['@babel/preset-env', { targets: { ie: '11' }, modules: false, useBuiltIns: false }]],
  comments: false,
  compact: true,
});
// Prefix runs before polyfills/import initialization, so device reports identify that boundary.
const gameCode =
  "if(window.DeskParkLegacy)window.DeskParkLegacy.stage('L2 GAME 游戏脚本已开始执行');\n" +
  result.code;
parse(gameCode, { ecmaVersion: 5 });
const bootstrapSource = await readFile(
  new URL('../apps/web/legacy/bootstrap.js', import.meta.url),
  'utf8',
);
// The bootstrap must pass the same syntax gate; formatters can add non-ES5 trailing argument commas.
const bootstrapResult = await transformAsync(bootstrapSource, {
  babelrc: false,
  configFile: false,
  presets: [['@babel/preset-env', { targets: { ie: '11' }, modules: false, useBuiltIns: false }]],
  comments: false,
  compact: true,
});
const bootstrapText = bootstrapResult.code;
parse(bootstrapText, { ecmaVersion: 5 });
const hash = (x) => createHash('sha256').update(x).digest('hex').slice(0, 12);
const js = `game-${hash(gameCode)}.js`;
const bootstrap = `bootstrap-${hash(bootstrapText)}.js`;
const cssText = await readFile(new URL('../apps/web/legacy/legacy.css', import.meta.url), 'utf8');
const css = `legacy-${hash(cssText)}.css`;
await writeFile(new URL(js, out), gameCode);
await writeFile(new URL(bootstrap, out), bootstrapText);
await writeFile(new URL(css, out), cssText);
await writeFile(
  new URL('index.html', out),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>闲亭 · 斗地主 iOS 12 兼容版</title><link rel="stylesheet" href="/legacy/${css}"></head><body><aside id="legacy-diagnostics" data-state="loading" style="display:block;background:#fff5d8;color:#172f29;padding:12px;margin:8px;border:2px solid #b68a27;font:16px sans-serif;overflow-wrap:break-word"><strong>闲亭 · 启动检查</strong><p id="legacy-status">L0 HTML 页面已到达，等待诊断脚本</p><pre id="legacy-error" style="display:none;white-space:pre-wrap;word-wrap:break-word"></pre><a style="color:#173d67" href="/legacy/?check=3">重新加载兼容版</a><p style="font-size:14px">如未出现开始按钮，请反馈本诊断区的阶段和错误文字；若完全看不到此区，请确认网址包含 /legacy/?check=3。</p></aside><div id="app"><h1>斗地主兼容版正在加载</h1><p>首次加载可能需要一点时间，上方诊断文字会显示进度或错误。</p></div><noscript>JavaScript 未开启，请在浏览器设置中开启。</noscript><script src="/legacy/${bootstrap}"></script><script defer src="/legacy/${js}"></script></body></html>`,
);
console.log(
  `Legacy build: ${fileURLToPath(out)}; ${js} (${Buffer.byteLength(result.code)} bytes), ES5 syntax verified; main dist untouched`,
);
