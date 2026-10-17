import type { NextConfig } from 'next';

// UI-only app: no server code, no proxy. The browser talks to the worker directly (ADR 0012).
const config: NextConfig = { reactStrictMode: true };
export default config;
