// 将服务器及其依赖（含引擎、协议、ws 与内联计算 Worker）打包为单文件，部署时无需 node_modules。
import { build } from 'esbuild';

const workerBundle = await build({
  entryPoints: ['src/botWorkerEntry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  write: false,
  logLevel: 'info',
});
const workerCode = workerBundle.outputFiles[0].text;

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/main.js',
  define: {
    __BOT_WORKER_CODE__: JSON.stringify(workerCode),
  },
  // ws 的可选原生加速依赖，不存在时会自动降级
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
