import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, copyFile, rename, writeFile, cp } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../apps/web/dist-legacy-tractor/', import.meta.url));
const shareRoot = join(homedir(), '.local/share/deskpark');
const root = join(shareRoot, 'web');
const target = join(root, 'legacy-tractor');
const lanIp =
  networkInterfaces().en0?.find((a) => a.family === 'IPv4' && !a.internal)?.address || '127.0.0.1';
const base = (process.env.DESKPARK_URL || `http://${lanIp}:8787`).replace(/\/$/, '');
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function snapshot(dir, prefix = '') {
  const files = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!prefix && e.name === 'legacy-tractor') continue;
    const rel = prefix + e.name;
    if (e.isDirectory()) Object.assign(files, await snapshot(join(dir, e.name), rel + '/'));
    else files[rel] = hash(await readFile(join(dir, e.name)));
  }
  return files;
}
const before = await snapshot(root);
const productionBefore = await snapshot(shareRoot);
const rollback =
  join(homedir(), '.local/share/deskpark-rollbacks/legacy-tractor-') +
  new Date().toISOString().replace(/[:.]/g, '-');
await mkdir(rollback, { recursive: true });
await cp(target, join(rollback, 'legacy-tractor'), { recursive: true });
await writeFile(join(rollback, 'protected-before.json'), JSON.stringify(productionBefore, null, 2));
const evidence = fileURLToPath(new URL('../apps/web/legacy-tractor-evidence/', import.meta.url));
await mkdir(evidence, { recursive: true });
await writeFile(join(evidence, 'production-before.json'), JSON.stringify(before, null, 2));
const legacySource = fileURLToPath(new URL('../apps/web/legacy/', import.meta.url));
const legacyBefore = await snapshot(legacySource);
await writeFile(join(evidence, 'legacy-source-before.json'), JSON.stringify(legacyBefore, null, 2));
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
  const response = await fetch(base + '/legacy-tractor/' + name);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(source, name)));
  console.log(`HTTP readback matches: /legacy-tractor/${name}`);
}
const after = await snapshot(root);
assert.deepEqual(after, before);
// Compare all production bytes except the single authorized route (including server).
const productionAfter = await snapshot(shareRoot);
const withoutTarget = (files) =>
  Object.fromEntries(
    Object.entries(files).filter(([name]) => !name.startsWith('web/legacy-tractor/')),
  );
assert.deepEqual(withoutTarget(productionAfter), withoutTarget(productionBefore));
assert.deepEqual(await snapshot(legacySource), legacyBefore);
await writeFile(join(evidence, 'production-after.json'), JSON.stringify(after, null, 2));
await writeFile(
  join(evidence, 'refinements/deployment.json'),
  JSON.stringify(
    {
      base,
      rollback,
      published: names,
      protectedProductionFiles: Object.keys(withoutTarget(productionBefore)).length,
      exactHttpReadback: true,
      isolatedBeforeAfterEqual: true,
    },
    null,
    2,
  ),
);
console.log('Rollback:', rollback);
assert.deepEqual(Buffer.from(await (await fetch(base + '/')).arrayBuffer()), mainBefore);
console.log(
  `PASS: ${Object.keys(before).length} pre-existing main files SHA256 unchanged; main HTTP body unchanged; no restart/config/network changes`,
);
