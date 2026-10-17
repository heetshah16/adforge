import { openDb, openPostgres } from './client';
import { diffColumns, listColumns } from './schema-diff';

const url = process.env.ADFORGE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('db:check needs ADFORGE_TEST_DATABASE_URL or DATABASE_URL set.');
  process.exit(2);
}

const pglite = await openDb();
let postgres: Awaited<ReturnType<typeof openPostgres>> | undefined;
try {
  // Applies pending migrations to the target Postgres database, not just reads it.
  try {
    postgres = await openPostgres(url);
  } catch (e) {
    const err = e as Error & { cause?: Error };
    console.error(`db:check: could not open Postgres (${err.cause?.message ?? err.message})`);
    process.exitCode = 1;
  }
  if (postgres) {
    const a = await listColumns(pglite.db);
    const b = await listColumns(postgres.db);
    const lines = diffColumns(a, b);
    if (lines.length) {
      for (const l of lines) console.log(l);
      process.exitCode = 1;
    } else {
      console.log(`schema parity ok (${a.length} columns)`);
    }
  }
} finally {
  await postgres?.close();
  await pglite.close();
}
