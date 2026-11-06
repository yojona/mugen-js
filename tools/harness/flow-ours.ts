// Run mugen-web's whole game flow in headless Chrome (CDP over WebSocket) and
// collect the flow harness output of tools/pages/harness-main.ts: FLOW lines and canvas
// shots. The page runs with ?ticks=N (as fast as possible, deterministic).
//
// Usage: tsx tools/harness/flow-ours.ts <outDir> <ticks> '<query string>'
// e.g.   ... out 6000 'fkeys=100:a;250:a&mash=FightScreen:a:6:2&clamp=1:1&shotevery=120'
// Writes <outDir>/flow.log and <outDir>/f<frame>.png.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [outDir, ticks, query] = process.argv.slice(2);
if (!outDir || !ticks) throw new Error('usage: flow-ours.ts outDir ticks query');
mkdirSync(outDir, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9333 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'flow-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,960', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

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

const log: string[] = [];
let done = false;
try {
  await json('/json/version');
  const target = await json('/json/new?about:blank', 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const send = (method: string, params: object = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a: any) => a.value ?? '').join(' ');
      if (text.startsWith('SHOT|')) {
        const [, frame, data] = text.split('|');
        writeFileSync(join(outDir, `f${frame.padStart(6, '0')}.png`), Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64'));
        log.push(`S|${frame}`);
      } else if (/^(FLOW|DBG|SEED)\|/.test(text)) log.push(text);
    }
    if (m.method === 'Runtime.exceptionThrown') log.push(`ERR|${JSON.stringify(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)}`);
  });
  send('Runtime.enable');
  send('Page.enable');
  // SELECT=path: that select.def instead of ref's (the flow harness's roster).
  const sel = process.env.SELECT ? `&selectb64=${encodeURIComponent(readFileSync(process.env.SELECT).toString('base64'))}` : '';
  send('Page.navigate', { url: `http://localhost:8120/harness.html?flowlog=1&ticks=${ticks}${sel}&${query ?? ''}` });
  const deadline = Date.now() + 30 * 60_000;
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    await new Promise<void>((res) => {
      const h = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data));
        if (m.id === id) {
          if (m.result?.result?.value === 'listo') done = true;
          ws.removeEventListener('message', h);
          res();
        }
      };
      ws.addEventListener('message', h);
    });
  }
  ws.close();
} finally {
  chrome.kill();
  writeFileSync(join(outDir, 'flow.log'), log.join('\n') + '\n');
  console.log(done ? 'done' : 'timeout', log.filter((l) => l.startsWith('FLOW')).length, 'flow lines');
}
