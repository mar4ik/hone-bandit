import net from 'node:net';
import type { Sql } from '../../src/server/pg-store.ts';

/**
 * A very small Postgres client for the tests: the extended query protocol (so `$1` parameters work as in production),
 * text format, no password. It exists because the real drivers cannot be installed here.
 * It copies how `pg` hands values back: bigint and numeric as strings, int4 and float as numbers, json parsed.
 */

export interface DbUrl {
  host: string;
  port: number;
  user: string;
  database: string;
}

export function parseDbUrl(url: string): DbUrl {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username || 'postgres'), database: u.pathname.slice(1) };
}

const int32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const int16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const message = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
};

interface Msg {
  type: string;
  body: Buffer;
}

export class PgError extends Error {
  code: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'postgres error');
    this.code = fields.C ?? '';
    this.name = 'PgError';
  }
}

function parseValue(oid: number, text: string): unknown {
  switch (oid) {
    case 16:
      return text === 't';
    case 21:
    case 23:
    case 26:
    case 700:
    case 701:
      return Number(text);
    case 114:
    case 3802:
      return JSON.parse(text);
    default:
      return text; // int8 (20), numeric (1700), text, and the rest stay strings, like `pg`
  }
}

function encodeParam(p: unknown): Buffer | null {
  if (p === null || p === undefined) return null;
  if (Array.isArray(p)) throw new Error('arrays are turned into Postgres arrays by real drivers; pass JSON text instead');
  if (typeof p === 'object') throw new Error('pass JSON as a string');
  return Buffer.from(typeof p === 'boolean' ? (p ? 'true' : 'false') : String(p), 'utf8');
}

export class PgConnection implements Sql {
  private socket: net.Socket;
  private buf = Buffer.alloc(0);
  private inbox: Msg[] = [];
  private waiter: (() => void) | null = null;
  private failure: Error | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (d: Buffer | string) => {
      this.buf = Buffer.concat([this.buf, typeof d === 'string' ? Buffer.from(d) : d]);
      while (this.buf.length >= 5) {
        const len = this.buf.readInt32BE(1);
        if (this.buf.length < len + 1) break;
        this.inbox.push({ type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, len + 1) });
        this.buf = this.buf.subarray(len + 1);
      }
      this.wake();
    });
    socket.on('error', (e) => {
      this.failure = e;
      this.wake();
    });
    socket.on('close', () => {
      this.failure ??= new Error('connection closed');
      this.wake();
    });
  }

  static async connect(url: DbUrl, options?: string): Promise<PgConnection> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(url.port, url.host, () => resolve(s));
      s.once('error', reject);
    });
    socket.setNoDelay(true);
    const c = new PgConnection(socket);
    const pairs = ['user', url.user, 'database', url.database, 'client_encoding', 'UTF8'];
    if (options) pairs.push('options', options);
    const body = Buffer.concat([int32(196608), ...pairs.map(cstr), Buffer.from([0])]);
    socket.write(Buffer.concat([int32(body.length + 4), body]));
    for (;;) {
      const m = await c.next();
      if (m.type === 'R' && m.body.readInt32BE(0) !== 0) throw new Error('the test server must allow this user without a password (trust)');
      if (m.type === 'E') throw new PgError(PgConnection.fields(m.body));
      if (m.type === 'Z') return c;
    }
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  private async next(): Promise<Msg> {
    for (;;) {
      const m = this.inbox.shift();
      if (m) return m;
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }

  private static fields(body: Buffer): Record<string, string> {
    const out: Record<string, string> = {};
    let i = 0;
    while (i < body.length && body[i] !== 0) {
      const code = String.fromCharCode(body[i]);
      const end = body.indexOf(0, i + 1);
      out[code] = body.toString('utf8', i + 1, end);
      i = end + 1;
    }
    return out;
  }

  query(text: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const run = async () => {
      const encoded = params.map(encodeParam);
      this.socket.write(
        Buffer.concat([
          message('P', cstr(''), cstr(text), int16(0)),
          message(
            'B',
            cstr(''),
            cstr(''),
            int16(0),
            int16(encoded.length),
            ...encoded.map((p) => (p === null ? int32(-1) : Buffer.concat([int32(p.length), p]))),
            int16(0),
          ),
          message('D', Buffer.from('P'), cstr('')),
          message('E', cstr(''), int32(0)),
          message('S'),
        ]),
      );
      let cols: Array<{ name: string; oid: number }> = [];
      const rows: Array<Record<string, unknown>> = [];
      let error: PgError | null = null;
      for (;;) {
        const m = await this.next();
        if (m.type === 'T') {
          cols = [];
          const n = m.body.readInt16BE(0);
          let i = 2;
          for (let k = 0; k < n; k++) {
            const end = m.body.indexOf(0, i);
            const name = m.body.toString('utf8', i, end);
            i = end + 1;
            const oid = m.body.readInt32BE(i + 6);
            i += 18;
            cols.push({ name, oid });
          }
        } else if (m.type === 'D') {
          const n = m.body.readInt16BE(0);
          let i = 2;
          const row: Record<string, unknown> = {};
          for (let k = 0; k < n; k++) {
            const len = m.body.readInt32BE(i);
            i += 4;
            if (len < 0) row[cols[k].name] = null;
            else {
              row[cols[k].name] = parseValue(cols[k].oid, m.body.toString('utf8', i, i + len));
              i += len;
            }
          }
          rows.push(row);
        } else if (m.type === 'E') {
          error = new PgError(PgConnection.fields(m.body));
        } else if (m.type === 'Z') {
          if (error) throw error;
          return { rows };
        }
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.socket.write(message('X'));
    this.socket.end();
  }
}

/** Several connections, so tests can make calls at the same time. */
export class PgPool implements Sql {
  private idle: PgConnection[] = [];
  private all: PgConnection[] = [];
  private waiting: Array<(c: PgConnection) => void> = [];

  static async connect(url: DbUrl, size: number, options?: string): Promise<PgPool> {
    const pool = new PgPool();
    pool.all = await Promise.all(Array.from({ length: size }, () => PgConnection.connect(url, options)));
    pool.idle = [...pool.all];
    return pool;
  }

  private async take(): Promise<PgConnection> {
    const c = this.idle.pop();
    if (c) return c;
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private give(c: PgConnection): void {
    const w = this.waiting.shift();
    if (w) w(c);
    else this.idle.push(c);
  }

  async query(text: string, params?: unknown[]) {
    const c = await this.take();
    try {
      return await c.query(text, params);
    } finally {
      this.give(c);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.all.map((c) => c.close()));
  }
}
