import type { NextConfig } from "next";

/**
 * Optional Stage 7 / 8C reverse-proxy: when ARA_NODE_BACKEND_URL is set, proxy
 * migrated APIs to Express while the browser keeps same-origin `/api/...`
 * URLs (cookie-friendly, no CORS required).
 *
 * Example: ARA_NODE_BACKEND_URL=http://127.0.0.1:3001
 * Do not put secrets in this URL.
 */
function nodeBackendRewrites(): { source: string; destination: string }[] {
  const target = (process.env.ARA_NODE_BACKEND_URL ?? "").trim().replace(/\/+$/, "");
  if (!target) return [];
  return [
    // Stage 7 — lateral read APIs
    {
      source: "/api/dataset/lateral/sync-history",
      destination: `${target}/api/dataset/lateral/sync-history`,
    },
    {
      source: "/api/excel/lateral/filters",
      destination: `${target}/api/excel/lateral/filters`,
    },
    // Stage 9 — Lateral P-Roles openings (Next Route Handler remains as rollback)
    {
      source: "/api/dataset/lateral/p-roles",
      destination: `${target}/api/dataset/lateral/p-roles`,
    },
    // Stage 10 — Home widgets (Next Route Handler remains as rollback)
    {
      source: "/api/home/widgets",
      destination: `${target}/api/home/widgets`,
    },
    // Stage 11 — Notifications GET+POST (Next Route Handler remains as rollback)
    {
      source: "/api/dataset/notifications",
      destination: `${target}/api/dataset/notifications`,
    },
    // Stage 13 — Dataset Sync History list + log (file-backed; Next handlers remain as rollback)
    {
      source: "/api/dataset/sync-history/:id/log",
      destination: `${target}/api/dataset/sync-history/:id/log`,
    },
    {
      source: "/api/dataset/sync-history",
      destination: `${target}/api/dataset/sync-history`,
    },
    // Stage 16 — Dataset Setup GET only (POST/DELETE remain on Next)
    {
      source: "/api/dataset/setup",
      destination: `${target}/api/dataset/setup`,
    },
    // Stage 18 — Drive metadata GET (encrypted local store; Next handler remains as rollback)
    {
      source: "/api/dataset/drive/metadata",
      destination: `${target}/api/dataset/drive/metadata`,
    },
    // Stage 8C-1 — authentication bridge (Next Route Handlers remain as rollback)
    {
      source: "/api/auth/login",
      destination: `${target}/api/auth/login`,
    },
    {
      source: "/api/auth/signup",
      destination: `${target}/api/auth/signup`,
    },
    {
      source: "/api/auth/logout",
      destination: `${target}/api/auth/logout`,
    },
    {
      source: "/api/auth/me",
      destination: `${target}/api/auth/me`,
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
