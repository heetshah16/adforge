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
  postgres = await openPostgres(url);
  const a = await listColumns(pglite.db);
  const b = await listColumns(postgres.db);
  const lines = diffColumns(a, b);
  if (lines.length) {
    for (const l of lines) console.log(l);
    process.exitCode = 1;
  } else {
    console.log(`schema parity ok (${a.length} columns)`);
  }
} finally {
  await postgres?.close();
  await pglite.close();
}
