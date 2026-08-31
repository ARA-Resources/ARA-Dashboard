import type { NextConfig } from "next";

/**
 * Optional Stage 7 / 8C reverse-proxy: when ARA_NODE_BACKEND_URL is set, proxy
 * migrated APIs to Express while the browser keeps same-origin `/api/...`
 * URLs (cookie-friendly, no CORS required).
 *
 * Example: ARA_NODE_BACKEND_URL=http://127.0.0.1:3001
 * Do not put secrets in this URL.
 */
type NodeRewrite = {
  source: string;
  destination: string;
  /** When set, rewrite applies only if these conditions are NOT matched. */
  missing?: Array<{ type: "query"; key: string; value: string }>;
};

function nodeBackendRewrites(): NodeRewrite[] {
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
    // Stage 19 — Connections GET only (DELETE remains on Next)
    {
      source: "/api/dataset/connections",
      destination: `${target}/api/dataset/connections`,
    },
    // Stage 20 — Dataset current GET (filesystem read-only; ?seed=1 remains on Next)
    {
      source: "/api/dataset/current",
      destination: `${target}/api/dataset/current`,
    },
    // Stage 20 — Drive folders GET (local metadata on Node; ?live=1 stays on Next)
    {
      source: "/api/dataset/drive/folders",
      missing: [{ type: "query", key: "live", value: "1" }],
      destination: `${target}/api/dataset/drive/folders`,
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
