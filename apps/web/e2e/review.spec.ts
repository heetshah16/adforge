import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const slug = process.env.ADFORGE_E2E_PRODUCT;
const root = fileURLToPath(new URL('../../../fixtures/eval-products/', import.meta.url)); // ESM package: no __dirname

test('upload → three ads → approve one, persisting after reload', async ({ page }) => {
  if (!slug) throw new Error('ADFORGE_E2E_PRODUCT is unset: set it to an eval-products folder name');
  const dir = join(root, slug!);
  const meta = JSON.parse(readFileSync(join(dir, 'product.json'), 'utf8')) as Record<string, string>;
  meta.price = meta.price!.replace(/\s*\(.*\)\s*$/, ''); // fixture notes like "(estimate ...)" exceed the 40-char price limit
  const photos = readdirSync(dir).filter((f) => ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(f).toLowerCase())).map((f) => join(dir, f));

  await page.goto('/');
  await page.getByLabel('Product name').fill(meta.name!);
  await page.getByLabel('Price').fill(meta.price!);
  await page.getByLabel('Description').fill(meta.description!);
  await page.getByLabel('Voice-over language').selectOption(meta.language!);
  await page.getByLabel(/Photos/).setInputFiles(photos);
  await page.getByRole('button', { name: 'Make three ads' }).click();

  await expect(page).toHaveURL(/\/jobs\//);
  console.log('job url:', page.url());
  await expect(page.getByRole('heading', { name: /Job/ })).toContainText('completed', { timeout: 55 * 60_000 });
  await expect(page.getByText('Strategist read')).toBeVisible();

  const videos = page.locator('.card video');
  await expect(videos).toHaveCount(3);
  for (const v of await videos.all()) {
    await expect.poll(async () => v.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(1); // metadata loaded → media served
  }
  await expect(page.getByText(/^Bet:/)).toHaveCount(3);

  // Non-asserting: evidence for the human check.
  await page.screenshot({ path: process.env.ADFORGE_E2E_SHOT ?? 'review.png', fullPage: true }).catch(() => {});

  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByRole('status')).toContainText('approved');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Approved' })).toHaveCount(1);
});
