import { join } from 'node:path';
import { REPO_ROOT } from '@adforge/core/config/env';

// Side-effect module, imported FIRST by entries: ESM evaluates imports before the importer's body, and @adforge/pipeline
// reads ADFORGE_ENV at import time to build the Inngest client.
try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
