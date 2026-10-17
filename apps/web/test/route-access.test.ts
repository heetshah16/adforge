import { describe, expect, it } from 'vitest';
import { routeAccess } from '../lib/route-access';

describe('routeAccess (deny by default)', () => {
  it.each(['/signin', '/waitlist', '/favicon.ico', '/auth/confirm', '/auth/signout', '/_next/static/x.js'])('%s is public', (p) => expect(routeAccess(p)).toBe('public'));
  it.each(['/api/jobs', '/api/jobs/1'])('%s is api', (p) => expect(routeAccess(p)).toBe('api'));
  it.each(['/', '/jobs/x', '/jobs/x.js', '/anything', '/signin/x', '/waitlist/x', '/authx', '/x.png', '/admin'])('%s is gated', (p) => expect(routeAccess(p)).toBe('gated'));
});
