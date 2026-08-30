import express from "express";
import type { NextFunction, Request, Response } from "express";
import { readDatabaseIdentity, selectOne } from "./db.js";
import { createLateralFiltersRouter } from "./routes/lateral-filters.js";
import { createLateralSyncHistoryRouter } from "./routes/lateral-sync-history.js";

const app = express();
const port = Number(process.env.PORT) || 3001;

/**
 * Stage 7: explicit CORS for browser → Express when origins differ.
 * ARA_CORS_ORIGINS=comma-separated list (e.g. http://localhost:3000).
 * Never uses Access-Control-Allow-Origin: *.
 */
function parseCorsOrigins(): string[] {
  return (process.env.ARA_CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

const corsOrigins = parseCorsOrigins();

if (corsOrigins.length > 0) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS"
      );
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
}

// Public liveness probe. Must remain unauthenticated.
app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(createLateralSyncHistoryRouter());
app.use(createLateralFiltersRouter());

app.get("/api/db-health", async (_req, res) => {
  try {
    await selectOne();
    const identity = await readDatabaseIdentity();
    res.status(200).json({
      ok: true,
      database: true,
      currentDatabase: identity.currentDatabase,
      currentUser: identity.currentUser,
    });
  } catch {
    res.status(503).json({
      ok: false,
      database: false,
    });
  }
});

app.listen(port, () => {
  console.log(`ARA backend listening on http://localhost:${port}`);
  console.log(`Health: http://localhost:${port}/api/health`);
  if (corsOrigins.length > 0) {
    console.log(`CORS origins: ${corsOrigins.join(", ")}`);
  }
});
