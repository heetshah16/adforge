import { describe, expect, it } from 'vitest';
import { config } from '../proxy';
import { routeAccess } from '../lib/route-access';

describe('routeAccess (deny by default)', () => {
  it.each(['/signin', '/waitlist', '/favicon.ico', '/auth/confirm', '/auth/signout', '/_next/static/x.js'])('%s is public', (p) => expect(routeAccess(p)).toBe('public'));
  // /api/inngest: Inngest calls it with no session; serve() verifies the request signature in cloud mode.
  it.each(['/api/jobs', '/api/jobs/1', '/api/uploads', '/api/uploads/local/ab/x.png', '/api/inngest'])('%s is api', (p) => expect(routeAccess(p)).toBe('api'));
  it.each(['/', '/jobs/x', '/jobs/x.js', '/anything', '/signin/x', '/waitlist/x', '/authx', '/x.png', '/admin'])('%s is gated', (p) => expect(routeAccess(p)).toBe('gated'));
});

describe('proxy matcher', () => {
  // Next compiles the matcher source to an anchored regex; mirror that.
  const re = new RegExp(`^${config.matcher[0]}$`);
  it.each(['/', '/jobs/x', '/signin', '/api/jobs', '/favicon.ico/x', '/faviconXico', '/favicon.icox'])('%s runs the proxy', (p) => expect(re.test(p)).toBe(true));
  it.each(['/favicon.ico', '/_next/static/a.js', '/auth/confirm'])('%s skips the proxy', (p) => expect(re.test(p)).toBe(false));
});

describe('/media', () => {
  it.each(['/media/org/x/ab/y.mp4', '/media/ab/y.png'])('%s self-authenticates like /api (never anonymous: the handler 401s)', (p) => expect(routeAccess(p)).toBe('api'));
});
