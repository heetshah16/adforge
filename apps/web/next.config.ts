import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@adforge/db', '@adforge/core', '@adforge/pipeline', '@adforge/provider-local-storage'],
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
};
export default config;
