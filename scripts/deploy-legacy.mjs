import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, copyFile, rename } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../apps/web/dist-legacy/', import.meta.url));
const root = join(homedir(), '.local/share/deskpark/web');
const target = join(root, 'legacy');
const lanIp =
  networkInterfaces().en0?.find((a) => a.family === 'IPv4' && !a.internal)?.address || '127.0.0.1';
const base = (process.env.DESKPARK_URL || `http://${lanIp}:8787`).replace(/\/$/, '');
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function snapshot(dir, prefix = '') {
  const files = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!prefix && e.name === 'legacy') continue;
    const rel = prefix + e.name;
    if (e.isDirectory()) Object.assign(files, await snapshot(join(dir, e.name), rel + '/'));
    else files[rel] = hash(await readFile(join(dir, e.name)));
  }
  return files;
}
const before = await snapshot(root);
const mainBefore = Buffer.from(await (await fetch(base + '/')).arrayBuffer());
const names = (await readdir(source)).filter((n) =>
  /^((game|bootstrap)-[a-f0-9]+\.js|legacy-[a-f0-9]+\.css|index\.html)$/.test(n),
);
assert(names.includes('index.html'));
await mkdir(target, { recursive: true });
for (const name of names.filter((n) => n !== 'index.html'))
  await copyFile(join(source, name), join(target, name));
await copyFile(join(source, 'index.html'), join(target, 'index.html.next'));
await rename(join(target, 'index.html.next'), join(target, 'index.html'));
for (const name of names) {
  const response = await fetch(base + '/legacy/' + name);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(source, name)));
  console.log(`HTTP readback matches: /legacy/${name}`);
}
assert.deepEqual(await snapshot(root), before);
assert.deepEqual(Buffer.from(await (await fetch(base + '/')).arrayBuffer()), mainBefore);
console.log(
  `PASS: ${Object.keys(before).length} pre-existing main files SHA256 unchanged; main HTTP body unchanged; no restart/config/network changes`,
);
