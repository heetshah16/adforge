import { openPostgres } from '../src/client';

/** Migrates the test Postgres once, before any file runs: parallel files migrating an empty database would race. */
export default async function setup() {
  const url = process.env.ADFORGE_TEST_DATABASE_URL;
  if (url) await (await openPostgres(url)).close();
}
