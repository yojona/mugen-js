// Render frame.html (a CPU match played to a frame) in headless Chrome and
// save the canvas as a PNG, to compare with a mugen.exe SHOTS capture
// (shot-diff.py).
//
// Usage: tsx tools/harness/frame-shot.ts out.png 'c1=athena-kofa&c2=leona-kofa&frame=400'
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [out, query] = process.argv.slice(2);
if (!out || !query) throw new Error('usage: frame-shot.ts out.png query');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9333 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'shot-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,960', 'about:blank'], { stdio: 'ignore' });

async function json(path: string, method = 'GET'): Promise<any> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      return await r.json();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('chrome did not start');
}

try {
  await json('/json/version');
  const target = await json('/json/new?about:blank', 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const call = (method: string, params: object = {}): Promise<any> =>
    new Promise((res) => {
      const my = ++id;
      const h = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data));
        if (m.id === my) {
          ws.removeEventListener('message', h);
          res(m.result);
        }
      };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({ id: my, method, params }));
    });
  await call('Page.enable');
  await call('Page.navigate', { url: `http://localhost:8120/frame.html?${query}` });
  const deadline = Date.now() + 10 * 60_000;
  let title = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const r = await call('Runtime.evaluate', { expression: '[window.__done === true, document.title]', returnByValue: true });
    const [done, t] = r?.result?.value ?? [false, ''];
    if (done) {
      title = t;
      break;
    }
  }
  // The WebGL buffer is not preserved: capture the page over the canvas.
  const rect = await call('Runtime.evaluate', { expression: "(() => { const b = document.getElementById('screen').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()", returnByValue: true });
  const [x, y, width, height] = rect.result.value;
  const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(title);
  ws.close();
} finally {
  chrome.kill();
}
