import { connect, ConnectionState } from 'inngest/connect';
import { inngest } from '@adforge/pipeline';

type Functions = NonNullable<Parameters<typeof connect>[0]['apps'][number]['functions']>;

/**
 * Prod: an outbound WebSocket to Inngest, so this machine opens no inbound port (docs/providers/inngest-connect.md).
 * handleShutdownSignals is empty because makeShutdown owns SIGINT/SIGTERM; it calls close() in its own order.
 * isActive: the connection is ACTIVE right now (not connecting, reconnecting, paused or closed); it gates the heartbeat.
 */
export async function startConnect(o: { functions: Functions; instanceId: string; connectFn?: typeof connect }): Promise<{ close(): Promise<void>; isActive(): boolean }> {
  const conn = await (o.connectFn ?? connect)({
    apps: [{ client: inngest, functions: o.functions }],
    instanceId: o.instanceId,
    maxWorkerConcurrency: 1,
    handleShutdownSignals: [],
  });
  return { close: () => conn.close(), isActive: () => conn.state === ConnectionState.ACTIVE };
}
