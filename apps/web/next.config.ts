import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  transpilePackages: ["@z1n/contracts"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } },
  },
};
export default nextConfig;
