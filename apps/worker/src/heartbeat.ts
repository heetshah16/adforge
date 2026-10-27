import { execFile } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import { workers } from '@adforge/db/schema';
import { freshOnline } from '@adforge/pipeline/dispatch';
import type { Db } from '@adforge/db/client';
import type { Env } from '@adforge/core/config/env';

export interface Probes {
  gpu(): Promise<{ gpu: string | null; vramFreeMb: number | null }>;
  services(): Promise<Record<string, boolean>>;
}

const PROBE_MS = 2_000;

/** nvidia-smi, 2 s cap. Never throws: no GPU or no driver is just nulls. */
function nvidiaSmi(): Promise<{ gpu: string | null; vramFreeMb: number | null }> {
  return new Promise((done) => {
    try {
      execFile('nvidia-smi', ['--query-gpu=name,memory.free', '--format=csv,noheader,nounits'], { timeout: PROBE_MS, windowsHide: true }, (err, out) => {
        if (err) return done({ gpu: null, vramFreeMb: null });
        const [name, free] = out.split('\n')[0]!.split(',').map((x) => x.trim());
        const n = Number(free);
        done({ gpu: name || null, vramFreeMb: Number.isFinite(n) ? Math.round(n) : null });
      });
    } catch {
      done({ gpu: null, vramFreeMb: null });
    }
  });
}

async function up(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) });
    void res.body?.cancel().catch(() => {}); // free the socket; only the status matters
    return res.ok;
  } catch {
    return false;
  }
}

/** ComfyUI has no /health; /system_stats is its cheapest GET. */
export function makeProbes(env: Pick<Env, 'COMFYUI_URL' | 'ADFORGE_VOICE_URL' | 'ADFORGE_QWEN_TTS_URL' | 'ADFORGE_VISION_URL'>): Probes {
  return {
    gpu: nvidiaSmi,
    services: async () => {
      const [comfyui, voice, qwen, vision] = await Promise.all([
        up(`${env.COMFYUI_URL}/system_stats`), up(`${env.ADFORGE_VOICE_URL}/health`), up(`${env.ADFORGE_QWEN_TTS_URL}/health`), up(`${env.ADFORGE_VISION_URL}/health`),
      ]);
      return { comfyui, voice, qwen, vision };
    },
  };
}

const OFFLINE_WRITE_MS = 1_000;
const SERVICES = ['comfyui', 'voice', 'qwen', 'vision'];

/** Upserts a `workers` row now and every intervalMs. A failed probe or write is logged-and-swallowed: the heartbeat must never take the worker down. */
export function startHeartbeat(o: { db: Db; instanceId: string; probes: Probes; intervalMs?: number; log?(m: string, e?: unknown): void }): { stop(): Promise<void> } {
  const log = o.log ?? ((m, e) => console.error(m, e ?? ''));
  let stopped = false;
  const write = async (status: 'online' | 'offline'): Promise<void> => {
    try {
      if (status === 'offline') {
        // Status only: last_seen stays the last real heartbeat, so a clean stop never looks fresher than a crash.
        await o.db.update(workers).set({ status }).where(eq(workers.instanceId, o.instanceId));
        return;
      }
      const [g, probed] = await Promise.all([
        o.probes.gpu().catch(() => ({ gpu: null, vramFreeMb: null })),
        o.probes.services().catch(() => ({} as Record<string, boolean>)),
      ]);
      const services = Object.fromEntries(SERVICES.map((k) => [k, probed[k] === true]));
      const set = { lastSeen: sql`now()`, status, gpu: g.gpu, vramFreeMb: g.vramFreeMb, services };
      // online_since: kept while the existing row is online and fresh (SET reads the old row), else a new stretch starts now.
      // coalesce: a row already fresh+online when 0021 landed (or after a quick restart under the same id) has no value yet.
      const onlineSince = sql`case when ${freshOnline} then coalesce(${workers.onlineSince}, now()) else now() end`;
      await o.db.insert(workers).values({ instanceId: o.instanceId, ...set, onlineSince: sql`now()` }).onConflictDoUpdate({ target: workers.instanceId, set: { ...set, onlineSince } });
    } catch (e) {
      log('heartbeat write failed', e);
    }
  };
  let inflight: Promise<void> = write('online');
  const timer = setInterval(() => { if (!stopped) inflight = write('online'); }, o.intervalMs ?? 30_000);
  timer.unref();
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await inflight;
      // Best effort, once, and bounded so a hung DB cannot eat the shutdown budget.
      let t: ReturnType<typeof setTimeout>;
      await Promise.race([write('offline'), new Promise<void>((r) => { t = setTimeout(r, OFFLINE_WRITE_MS); })]);
      clearTimeout(t!);
    },
  };
}

// Moved to the light dispatch module (the web reads it too); re-exported for the worker's callers.
export { lastSeenOnline } from '@adforge/pipeline/dispatch';
