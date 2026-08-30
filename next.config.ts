import type { NextConfig } from "next";

/**
 * Optional Stage 7 reverse-proxy: when ARA_NODE_BACKEND_URL is set, proxy the
 * migrated lateral read APIs to Express while the browser keeps same-origin
 * `/api/...` URLs (cookie-friendly, no CORS required).
 *
 * Example: ARA_NODE_BACKEND_URL=http://127.0.0.1:3001
 * Do not put secrets in this URL.
 */
function nodeBackendRewrites(): { source: string; destination: string }[] {
  const target = (process.env.ARA_NODE_BACKEND_URL ?? "").trim().replace(/\/+$/, "");
  if (!target) return [];
  return [
    {
      source: "/api/dataset/lateral/sync-history",
      destination: `${target}/api/dataset/lateral/sync-history`,
    },
    {
      source: "/api/excel/lateral/filters",
      destination: `${target}/api/excel/lateral/filters`,
    },
  ];
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // beforeFiles: required so these paths proxy to Node even while the
    // legacy Next Route Handlers still exist (afterFiles lose to static routes).
    return {
      beforeFiles: nodeBackendRewrites(),
    };
  },
};

export default nextConfig;
