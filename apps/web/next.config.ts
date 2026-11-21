import path from "node:path";
import type { NextConfig } from "next";

// Read at build time and written into the routes manifest; the image sets it as a build argument.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  output: "standalone",
  // The repository root, so the trace picks up the workspace packages and the pnpm store.
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  experimental: {
    // Next drops a proxied connection silent for longer than this, and replaces 0 with its
    // 30 s default, so the live event stream needs the largest delay a Node socket timer accepts.
    proxyTimeout: 2147483647,
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }];
  },
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
