import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { parse } from 'acorn';
const dir = new URL('../apps/web/dist-legacy/', import.meta.url);
const html = await readFile(new URL('index.html', dir), 'utf8');
const policy =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'";
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (match[2].trim()) parse(match[2], { ecmaVersion: 5 });
  const src = /src="\/legacy\/([^"]+)"/.exec(match[1]);
  if (src) parse(await readFile(new URL(src[1], dir), 'utf8'), { ecmaVersion: 5 });
}
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname.split('/').pop() || 'index.html';
    const body = await readFile(new URL(name, dir));
    res.writeHead(200, {
      'Content-Type': name.endsWith('.js')
        ? 'text/javascript'
        : name.endsWith('.css')
          ? 'text/css'
          : 'text/html',
      'Content-Security-Policy': policy,
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/legacy/`;
try {
  for (const [name, type] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await type.launch();
    try {
      const nojs = await browser.newPage({ javaScriptEnabled: false });
      await nojs.goto(url);
      assert(
        await nojs.locator('#legacy-diagnostics').isVisible(),
        'static pre-JS diagnostic survives with JavaScript disabled',
      );
      assert.match(await nojs.locator('#legacy-diagnostics').innerText(), /L0 HTML/);
      await nojs.close();
      for (const scenario of ['blocked', 'syntax', 'render', 'timeout', 'ready', 'no-css']) {
        const page = await browser.newPage();
        if (scenario === 'timeout') await page.clock.install();
        if (scenario === 'no-css') await page.route('**/*.css', (r) => r.abort());
        if (['blocked', 'syntax', 'render', 'timeout'].includes(scenario)) {
          await page.route('**/game-*.js', async (route) => {
            if (scenario === 'blocked') return route.abort();
            if (scenario === 'timeout')
              return route.fulfill({ contentType: 'text/javascript', body: '' });
            if (scenario === 'syntax')
              return route.fulfill({ contentType: 'text/javascript', body: 'var = ;' });
            const response = await route.fetch();
            const body = await response.text();
            assert(body.includes('function App(){'), 'render probe targets real App function');
            await route.fulfill({
              response,
              body: body.replace(
                'function App(){',
                'function App(){throw new Error("render-probe");',
              ),
            });
          });
        }
        await page.goto(url);
        const diag = page.locator('#legacy-diagnostics');
        if (scenario === 'timeout') await page.clock.fastForward(16000);
        if (['ready', 'no-css'].includes(scenario)) {
          await page.getByRole('button', { name: '开始游戏', exact: true }).waitFor();
          await page.waitForFunction(
            () =>
              document.getElementById('legacy-diagnostics').getAttribute('data-state') === 'ready',
          );
          assert.equal(
            await diag.isVisible(),
            false,
            'healthy mount hides diagnostic even without CSS',
          );
          await page.goto(url + '?debug=1');
          await page.waitForFunction(
            () =>
              document.getElementById('legacy-diagnostics').getAttribute('data-state') === 'ready',
          );
          assert(await diag.isVisible(), 'debug opt-in reveals healthy diagnostic');
          assert.match(await diag.innerText(), /L3 READY/);
          await page.goto(url + '?check=3');
          await page.waitForFunction(
            () =>
              document.getElementById('legacy-diagnostics').getAttribute('data-state') === 'ready',
          );
          assert.equal(await diag.isVisible(), false);
          // A post-mount fatal error must remain visible outside React's root too.
          await page.evaluate(() =>
            setTimeout(function () {
              throw new Error('late-probe');
            }, 0),
          );
          await page.waitForFunction(
            () =>
              document.getElementById('legacy-diagnostics').getAttribute('data-state') === 'error',
          );
          assert(await diag.isVisible(), 'late error reopens hidden diagnostic');
          assert.match(await diag.innerText(), /late-probe/);
        } else {
          await page.waitForFunction(
            () =>
              document.getElementById('legacy-diagnostics').getAttribute('data-state') === 'error',
          );
          assert(await diag.isVisible(), `${scenario}: no blank fallback`);
          assert.match(
            await diag.innerText(),
            scenario === 'render' ? /render-probe/ : scenario === 'timeout' ? /TIMEOUT/ : /ERROR/,
          );
          assert(await diag.getByRole('link', { name: '重新加载兼容版' }).isVisible());
        }
        await page.close();
      }
      console.log(
        `PASS ${name}: ES5 scripts + enforced CSP; no-JS, blocked bundle, syntax failure, React render failure, watchdog timeout, ready, missing CSS, post-mount error stay visible`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
