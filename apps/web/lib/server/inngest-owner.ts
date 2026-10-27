import { serve } from 'inngest/next';
import { createLightFunctions } from '@adforge/pipeline/light';
import { getDb } from './db';
import { inngest } from './events';

// The adforge-web app's endpoint (dispatcher + janitor). Owner connection: the dispatcher and janitor are system work across
// every org, never a member's. Lazy, so `next build` neither parses the env nor builds the client.
let handler: ReturnType<typeof serve> | undefined;

// enableUnauthedSync false (cloud mode only): every request, sync PUTs included, must carry Inngest's signature. Syncs then go
// through the Inngest UI/API or the Vercel integration, never an anonymous PUT.
export const inngestHandler = () => (handler ??= serve({ client: inngest(), functions: createLightFunctions(inngest(), getDb), enableUnauthedSync: false }));
