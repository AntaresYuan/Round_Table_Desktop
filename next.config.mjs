/** @type {import('next').NextConfig} */
const nextConfig = {
  // The server modules use ESM-style `.js` extensions on relative imports
  // (e.g. `../db/index.js`). tsc/tsx/vitest resolve those to `.ts`; webpack does
  // not by default — teach it to, so route handlers can import `@/server/*`.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
