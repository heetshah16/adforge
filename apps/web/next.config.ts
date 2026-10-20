import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@adforge/db', '@adforge/core', '@adforge/pipeline', '@adforge/provider-local-storage', '@adforge/provider-r2', '@adforge/renderer-hyperframes'],
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
};
export default config;
