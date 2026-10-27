import { connect } from 'inngest/connect';
import { inngest } from '@adforge/pipeline';

type Functions = NonNullable<Parameters<typeof connect>[0]['apps'][number]['functions']>;

/**
 * Prod: an outbound WebSocket to Inngest, so this machine opens no inbound port (docs/providers/inngest-connect.md).
 * handleShutdownSignals is empty because makeShutdown owns SIGINT/SIGTERM; it calls close() in its own order.
 */
export async function startConnect(o: { functions: Functions; instanceId: string; connectFn?: typeof connect }): Promise<{ close(): Promise<void> }> {
  const conn = await (o.connectFn ?? connect)({
    apps: [{ client: inngest, functions: o.functions }],
    instanceId: o.instanceId,
    maxWorkerConcurrency: 1,
    handleShutdownSignals: [],
  });
  return { close: () => conn.close() };
}
