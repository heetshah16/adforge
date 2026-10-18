import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The proxy runs on every path except _next/, favicon.ico and auth/; Next clones request bodies for it and truncates past this (default 10 MB). The upload cap is 30 MB.
  experimental: { proxyClientMaxBodySize: '31mb' },
  transpilePackages: ['@adforge/db', '@adforge/core', '@adforge/pipeline', '@adforge/provider-local-storage'],
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
};
export default config;
