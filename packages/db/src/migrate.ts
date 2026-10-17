import { openPostgres } from './client';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('db:migrate needs DATABASE_URL set.');
  process.exit(2);
}
const { close } = await openPostgres(url); // applies pending migrations
await close();
console.log('migrations applied');
