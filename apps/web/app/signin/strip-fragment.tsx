'use client';
import { useEffect } from 'react';
import { stripTokenFragment } from '../../lib/strip-fragment';

export function StripFragment() {
  useEffect(() => stripTokenFragment(location, (url) => history.replaceState(null, '', url)), []);
  return null;
}
