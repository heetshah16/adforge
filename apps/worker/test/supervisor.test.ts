import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Windows PowerShell 5.1 + a dummy node child only. The real GPU services are never started here.
const SCRIPTS = resolve(__dirname, '../../../scripts');
const d = process.platform === 'win32' ? describe : describe.skip;

type Rec = { event: string; service?: string; pid?: number; code?: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const PS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

let supervisors: ReturnType<typeof spawn>[] = [];
afterEach(() => { for (const s of supervisors) if (s.pid) spawnSync('taskkill', ['/T', '/F', '/PID', String(s.pid)]); supervisors = []; });

function boot(svc: Record<string, unknown>, exitCode?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'adforge-sup-'));
  const child = join(dir, 'child.cjs');
  writeFileSync(child, `const fs=require('fs');const [sig,exit]=process.argv.slice(2);
if(exit){process.exit(Number(exit));}
setInterval(()=>{if(fs.existsSync(sig))process.exit(0);},200);`);
  const stop = join(dir, 'stop');
  const cfg = join(dir, 'cfg.json');
  const args = exitCode ? [child, join(dir, 'sig'), String(exitCode)] : [child, join(dir, 'sig')];
  writeFileSync(cfg, JSON.stringify({ services: [{ name: 'dummy', cwd: dir, command: process.execPath, args, restartOn: 'any', maxRestarts: 5, windowMin: 10, backoffSec: 1, ...svc }] }));
  const sup = spawn('powershell', [...PS, join(SCRIPTS, 'supervisor.ps1'), '-Config', cfg, '-StopFile', stop], { env: { ...process.env, ADFORGE_DATA_DIR: dir }, stdio: 'ignore' });
  supervisors.push(sup);
  const recs = (): Rec[] => {
    const logs = join(dir, 'logs');
    if (!existsSync(logs)) return [];
    const f = readdirSync(logs).find((n) => n.startsWith('supervisor-'));
    return f ? readFileSync(join(logs, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec) : [];
  };
  const until = async (pred: () => boolean, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(250); } return false; };
  return { stop, recs, until, sup, started: () => recs().filter((r) => r.event === 'started') };
}

d('supervisor.ps1', () => {
  it('restarts a killed child within 30 s', async () => {
    const h = boot({});
    expect(await h.until(() => h.started().length === 1, 20_000)).toBe(true);
    spawnSync('taskkill', ['/T', '/F', '/PID', String(h.started()[0]!.pid)]);
    expect(await h.until(() => h.started().length === 2, 30_000)).toBe(true);
    expect(h.started()[1]!.pid).not.toBe(h.started()[0]!.pid);
  }, 70_000);

  it('stops restarting after maxRestarts in the window and logs it', async () => {
    const h = boot({ maxRestarts: 2 }, 1);
    expect(await h.until(() => h.recs().some((r) => r.event === 'gave-up'), 30_000)).toBe(true);
    expect(h.started()).toHaveLength(3);
    await sleep(2500);
    expect(h.started()).toHaveLength(3);
  }, 45_000);

  it('does not restart when the exit code is outside restartOn', async () => {
    const h = boot({ restartOn: [3] }, 1);
    expect(await h.until(() => h.recs().some((r) => r.event === 'exited-final'), 20_000)).toBe(true);
    expect(h.started()).toHaveLength(1);
  }, 30_000);

  it('stopping the supervisor leaves no child alive', async () => {
    const h = boot({});
    expect(await h.until(() => h.started().length === 1, 20_000)).toBe(true);
    const pid = h.started()[0]!.pid!;
    writeFileSync(h.stop, '');
    expect(await h.until(() => !alive(pid), 15_000)).toBe(true);
    expect(await h.until(() => h.sup.exitCode !== null, 15_000)).toBe(true);
  }, 50_000);
});

d('install-supervisor.ps1', () => {
  const run = (...a: string[]) => spawnSync('powershell', [...PS, join(SCRIPTS, 'install-supervisor.ps1'), ...a], { encoding: 'utf8' });
  const registered = () => spawnSync('powershell', ['-NoProfile', '-Command', "if (Get-ScheduledTask -TaskName 'AdForge supervisor' -ErrorAction SilentlyContinue) { 'present' } else { 'absent' }"], { encoding: 'utf8' }).stdout.trim();
  it('-WhatIf prints the action and registers nothing', () => {
    const before = registered();
    const r = run('-WhatIf');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AdForge supervisor/);
    expect(r.stdout).toMatch(/supervisor\.ps1/);
    expect(registered()).toBe(before);
  });
  it('-Uninstall -WhatIf removes nothing', () => {
    const before = registered();
    const r = run('-Uninstall', '-WhatIf');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/remove/i);
    expect(registered()).toBe(before);
  });
});
