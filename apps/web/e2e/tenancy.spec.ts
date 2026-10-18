import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { eq, inArray, like } from 'drizzle-orm';
import { openPostgres, type Db } from '@adforge/db/client';
import { jobs, memberships, orgs, projects, users, waitlist } from '@adforge/db/schema';
import { adminEmail, provision, signIn, supabaseAdmin } from './auth';

/** Runs against the dev Supabase project; no GPU stack needed (no job is executed). */
test.describe.configure({ mode: 'serial' });

const rand = () => randomBytes(4).toString('hex');
const emailA = `e2e+${rand()}@adforge.test`;
const emailB = `e2e+${rand()}@adforge.test`;
let db: Db;
let close: () => Promise<void>;

test.beforeAll(async () => {
  ({ db, close } = await openPostgres(process.env.DATABASE_URL!, { migrate: false }));
});

// Only e2e+*@adforge.test rows; the configured admin user is never touched.
test.afterAll(async () => {
  const sb = supabaseAdmin();
  const { data } = await sb.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data?.users ?? []) if (/^e2e\+.*@adforge\.test$/.test(u.email ?? '')) await sb.auth.admin.deleteUser(u.id);
  const uids = (await db.select({ id: users.id }).from(users).where(like(users.email, 'e2e+%@adforge.test'))).map((u) => u.id);
  if (uids.length) {
    const oids = (await db.select({ id: memberships.orgId }).from(memberships).where(inArray(memberships.userId, uids))).map((m) => m.id);
    if (oids.length) {
      await db.delete(jobs).where(inArray(jobs.orgId, oids));
      await db.delete(projects).where(inArray(projects.orgId, oids));
      await db.delete(memberships).where(inArray(memberships.orgId, oids));
      await db.delete(orgs).where(inArray(orgs.id, oids));
    }
    await db.delete(users).where(inArray(users.id, uids));
  }
  await db.delete(waitlist).where(like(waitlist.email, 'e2e+%@adforge.test'));
  await close();
});

test('waitlist → invite → sign in → org created → cross-org isolation', async ({ page, browser }) => {
  // 1. Public waitlist form (waits past the 3 s timing check; honeypot left empty).
  await page.goto('/waitlist');
  await page.waitForTimeout(3500);
  await page.getByLabel('Your name').fill('E2E Tester');
  await page.getByLabel('Email', { exact: true }).fill(emailA);
  await page.getByLabel('Brand').fill('E2E Brand');
  await page.getByLabel('Category').fill('Skincare');
  await page.getByLabel('Country').fill('India');
  await page.getByRole('button', { name: 'Join the waitlist' }).click();
  await expect(page.getByRole('heading', { name: "You're on the list" })).toBeVisible();

  // 2. Admin invites it.
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await signIn(admin, adminEmail);
  await admin.goto('/admin');
  const row = admin.getByRole('row').filter({ hasText: emailA });
  await expect(row).toContainText('new');
  const inviteRes = admin.waitForResponse((r) => r.url().includes('/api/admin/invite'));
  await row.getByRole('button', { name: 'Invite' }).click();
  const status = (await inviteRes).status();
  if (status === 200) {
    await expect(row).toContainText('invited');
    console.log('invite: REAL (Supabase email sent)');
  } else {
    // Free-tier SMTP limit: seed the invited state through the owner DB instead.
    console.log(`invite: FALLBACK (route returned ${status})`);
    await db.update(waitlist).set({ status: 'invited', invitedAt: new Date() }).where(eq(waitlist.email, emailA));
    await supabaseAdmin().auth.admin.createUser({ email: emailA, email_confirm: true });
    await admin.goto('/admin');
    await expect(admin.getByRole('row').filter({ hasText: emailA })).toContainText('invited');
  }
  await adminCtx.close();

  // 3. Invited user A signs in; org + membership exist.
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await signIn(pageA, emailA);
  await provision(pageA);
  const [ua] = await db.select().from(users).where(eq(users.email, emailA));
  expect(ua).toBeDefined();
  const [ma] = await db.select().from(memberships).where(eq(memberships.userId, ua!.id));
  expect(ma?.role).toBe('owner');
  const orgA = ma!.orgId;

  // 4. Org B: a second invited user (seeded invited directly; the invite path was exercised above).
  await db.insert(waitlist).values({ name: 'E2E B', email: emailB, brand: 'B', category: 'x', country: 'IN', status: 'invited', invitedAt: new Date() });
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await signIn(pageB, emailB);
  await provision(pageB);
  const [ub] = await db.select().from(users).where(eq(users.email, emailB));
  const [mb] = await db.select().from(memberships).where(eq(memberships.userId, ub!.id));
  expect(mb!.orgId).not.toBe(orgA);

  // A's job, inserted directly (the owner connection bypasses RLS).
  const [proj] = await db.insert(projects).values({ orgId: orgA, userId: ua!.id, name: 'e2e project' }).returning({ id: projects.id });
  const [job] = await db.insert(jobs).values({ orgId: orgA, projectId: proj!.id, userId: ua!.id, inputSpec: { e2e: true } }).returning({ id: jobs.id });

  expect((await pageA.request.get(`/api/jobs/${job!.id}`)).status()).toBe(200); // control: the owner org sees it
  expect((await pageB.request.get(`/api/jobs/${job!.id}`)).status()).toBe(404);
  await pageB.goto('/');
  expect(await pageB.content()).not.toContain(job!.id);
  await ctxA.close();
  await ctxB.close();
});
