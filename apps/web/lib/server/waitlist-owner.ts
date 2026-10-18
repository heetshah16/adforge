import { waitlist } from '@adforge/db/schema';
import type { Db } from '@adforge/db/client';
import { getDb } from './db';

export type WaitlistRow = {
  name: string; email: string; brand: string; website?: string; category: string; country: string; note?: string;
};

/** Owner-only: anon and authenticated have no insert privilege on waitlist. A duplicate email is a silent no-op. */
export async function insertWaitlist(db: Db, row: WaitlistRow): Promise<void> {
  await db.insert(waitlist).values(row).onConflictDoNothing({ target: waitlist.email });
}

export const addToWaitlist = async (row: WaitlistRow) => insertWaitlist(await getDb(), row);
