import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const SECRET = /key|secret|token|password|database_?url/i;
const KEEP = 14;

function redact(v: unknown, depth = 0): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') return v;
  if (depth > 5) return '[truncated]';
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? '[redacted]' : redact(x, depth + 1)]));
}

/** One JSON line per call, to stdout and to <dir>/logs/worker-YYYYMMDD.log (daily file, newest 14 kept). */
export function createLogger(o: { dir: string; now?: () => Date; stdout?: (line: string) => void }) {
  const now = o.now ?? (() => new Date());
  const stdout = o.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const logs = join(o.dir, 'logs');
  let day = '';
  const emit = (level: string, msg: string, fields: Record<string, unknown> = {}) => {
    const t = now();
    let line: string;
    try {
      line = JSON.stringify({ ts: t.toISOString(), level, msg, ...(redact(fields) as object) });
    } catch {
      // circular or otherwise unserializable fields must not crash the worker
      line = JSON.stringify({ ts: t.toISOString(), level, msg, fieldsError: 'unserializable fields dropped' });
    }
    stdout(line);
    try {
      const today = t.toISOString().slice(0, 10).replaceAll('-', '');
      if (today !== day) {
        mkdirSync(logs, { recursive: true });
        const old = readdirSync(logs).filter((f) => /^worker-\d{8}\.log$/.test(f) && f !== `worker-${today}.log`).sort();
        for (const f of old.slice(0, Math.max(0, old.length - (KEEP - 1)))) unlinkSync(join(logs, f));
        day = today;
      }
      appendFileSync(join(logs, `worker-${today}.log`), `${line}\n`);
    } catch { /* a full disk must not take the worker down; stdout already has the line */ }
  };
  return {
    info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
  };
}

/** Adapts the logger to the `(msg, err?)` sink the heartbeat, shutdown and handler take. */
export const errorSink = (l: ReturnType<typeof createLogger>) => (msg: string, e?: unknown) => l.error(msg, e === undefined ? {} : { error: e });
