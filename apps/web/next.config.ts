import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // The workspace packages have no build: Next compiles their TypeScript source.
  transpilePackages: ["@agent-os/common", "@agent-os/contracts"],
  cacheComponents: true,
  partialPrefetching: true,
  // Baseline hardening for every route. A script CSP is not set here: the inline theme
  // and bootstrap scripts would need hashes first.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
