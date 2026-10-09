import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Just enough of the Chrome DevTools protocol to load a page, click, read values and take a picture. */

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class Page {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners: Array<(method: string, params: any) => void> = [];
  readonly consoleErrors: string[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (p) msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else {
        for (const l of this.listeners) l(msg.method, msg.params);
      }
    });
  }

  static async open(wsUrl: string): Promise<Page> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('cannot reach Chrome')));
    });
    return new Page(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(fn: (method: string, params: any) => void): void {
    this.listeners.push(fn);
  }

  async setup(userAgent: string, allowedHosts: string[]): Promise<void> {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Emulation.setUserAgentOverride', { userAgent });
    // No traffic leaves the machine: anything that is not one of ours is refused at once.
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    this.on((method, p) => {
      if (method === 'Fetch.requestPaused') {
        const host = new URL(p.request.url).hostname;
        const ok = allowedHosts.includes(host) || p.request.url.startsWith('data:');
        void this.send(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
      if (method === 'Runtime.exceptionThrown') this.consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception');
    });
  }

  async goto(url: string, waitMs = 8000): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, waitMs);
      this.on((method) => {
        if (method === 'Page.loadEventFired') {
          clearTimeout(t);
          resolve();
        }
      });
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  async waitFor(expression: string, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval<boolean>(`Boolean(${expression})`).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`timed out waiting for: ${expression}`);
  }

  async screenshot(file: string, width = 1280, height = 800): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  close(): void {
    this.ws.close();
  }
}

export class Chrome {
  private proc: ChildProcess;
  private port: number;

  private constructor(proc: ChildProcess, port: number) {
    this.proc = proc;
    this.port = port;
  }

  static async launch(exe: string, userAgent: string, port = 9333 + Math.floor(Math.random() * 500)): Promise<Chrome> {
    const dir = mkdtempSync(join(tmpdir(), 'hone-chrome-'));
    const proc = spawn(exe, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', `--user-agent=${userAgent}`, `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
    const chrome = new Chrome(proc, port);
    const end = Date.now() + 15000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return chrome;
      } catch {
        // not up yet
      }
      if (Date.now() > end) throw new Error('Chrome did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** A fresh page in a fresh private window: no storage shared with other pages. */
  async newPage(): Promise<Page> {
    const ctx = (await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const browser = await Page.open(ctx.webSocketDebuggerUrl);
    const { browserContextId } = await browser.send('Target.createBrowserContext');
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
    browser.close();
    const list = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as Array<{ id: string; webSocketDebuggerUrl: string }>;
    const target = list.find((t) => t.id === targetId);
    if (!target) throw new Error('page not found');
    return Page.open(target.webSocketDebuggerUrl);
  }

  close(): void {
    this.proc.kill('SIGKILL');
  }
}
