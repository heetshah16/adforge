import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@adforge/db', '@adforge/core'],
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
};
export default config;
