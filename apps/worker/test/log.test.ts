import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/log';

const setup = (now: () => Date) => {
  const dir = mkdtempSync(join(tmpdir(), 'adforge-log-'));
  const lines: string[] = [];
  return { dir, lines, logger: createLogger({ dir, now, stdout: (l) => lines.push(l) }) };
};

describe('worker logger', () => {
  it('writes one JSON line to stdout and to the daily file', () => {
    const { dir, lines, logger } = setup(() => new Date('2026-10-27T10:00:00Z'));
    logger.info('hello', { jobId: 'j1' });
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: 'info', msg: 'hello', jobId: 'j1', ts: '2026-10-27T10:00:00.000Z' });
    expect(readFileSync(join(dir, 'logs', 'worker-20261027.log'), 'utf8')).toBe(`${lines[0]}\n`);
  });

  it('rotates by date and keeps 14 files', () => {
    let d = new Date('2026-10-01T10:00:00Z');
    const { dir, logger } = setup(() => d);
    const logs = join(dir, 'logs');
    mkdirSync(logs, { recursive: true });
    for (let i = 1; i <= 20; i++) writeFileSync(join(logs, `worker-202609${String(i).padStart(2, '0')}.log`), '');
    logger.warn('a');
    d = new Date('2026-10-02T10:00:00Z');
    logger.error('b');
    const files = readdirSync(logs).filter((f) => f.startsWith('worker-')).sort();
    expect(files).toHaveLength(14);
    expect(files.at(-1)).toBe('worker-20261002.log');
    expect(files).not.toContain('worker-20260901.log');
  });

  it('redacts secret-named keys, nested, and never logs their values', () => {
    const { dir, lines, logger } = setup(() => new Date('2026-10-27T10:00:00Z'));
    logger.info('x', { apiKey: 'sk-AAA', DATABASE_URL: 'postgres://u:p@h/d', nested: { client_secret: 'sec-BBB', my_token: 'tok-CCC', Password: 'pw-DDD' }, ok: 'fine' });
    const text = lines[0]! + readFileSync(join(dir, 'logs', 'worker-20261027.log'), 'utf8');
    for (const s of ['sk-AAA', 'postgres://', 'sec-BBB', 'tok-CCC', 'pw-DDD']) expect(text).not.toContain(s);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: 'fine', apiKey: '[redacted]', nested: { Password: '[redacted]' } });
  });

  it('truncates past the depth limit and survives circular and BigInt values', () => {
    const { lines, logger } = setup(() => new Date('2026-10-27T10:00:00Z'));
    const deep = { a: { b: { c: { d: { e: { f: { secretish: 'x', g: 1 } } } } } } };
    logger.info('deep', deep);
    expect(lines[0]).toContain('[truncated]');
    expect(lines[0]).not.toContain('secretish');
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(() => logger.info('circ', { circ, big: 10n })).not.toThrow();
    expect(() => logger.info('circ2', circ)).not.toThrow();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!)).toMatchObject({ msg: 'circ' });
  });
});
