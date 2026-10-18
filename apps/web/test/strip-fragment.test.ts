import { describe, expect, it } from 'vitest';
import { stripTokenFragment } from '../lib/strip-fragment';

describe('stripTokenFragment', () => {
  it('drops a token fragment but keeps path and query', () => {
    const calls: string[] = [];
    stripTokenFragment({ hash: '#access_token=a&refresh_token=b', pathname: '/signin', search: '?invited=1' }, (u) => calls.push(u));
    expect(calls).toEqual(['/signin?invited=1']);
  });
  it('leaves other fragments alone', () => {
    const calls: string[] = [];
    stripTokenFragment({ hash: '#top', pathname: '/signin', search: '' }, (u) => calls.push(u));
    stripTokenFragment({ hash: '', pathname: '/signin', search: '' }, (u) => calls.push(u));
    expect(calls).toEqual([]);
  });
});
