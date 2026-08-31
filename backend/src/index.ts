import express from "express";
import type { NextFunction, Request, Response } from "express";
import { readDatabaseIdentity, selectOne } from "./db.js";
import { createAuthRouter } from "./routes/auth.js";
import { createHomeWidgetsRouter } from "./routes/home-widgets.js";
import { createLateralFiltersRouter } from "./routes/lateral-filters.js";
import { createLateralPRolesRouter } from "./routes/lateral-p-roles.js";
import { createLateralSyncHistoryRouter } from "./routes/lateral-sync-history.js";
import { createDatasetDriveMetadataRouter } from "./routes/dataset-drive-metadata.js";
import { createDatasetConnectionsRouter } from "./routes/dataset-connections.js";
import { createDatasetCurrentRouter } from "./routes/dataset-current.js";
import { createDatasetDriveFoldersRouter } from "./routes/dataset-drive-folders.js";
import { createDatasetSetupRouter } from "./routes/dataset-setup.js";
import { createDatasetSyncHistoryRouter } from "./routes/dataset-sync-history.js";
import { createLateralProcessingSetupRouter } from "./routes/lateral-processing-setup.js";
import { createNotificationsRouter } from "./routes/notifications.js";

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

// Required for POST /api/auth/login and /api/auth/signup JSON bodies.
app.use(express.json({ limit: "32kb" }));

// Stage 11: match Next notifications POST — invalid JSON body → empty object
// (then "Unknown action." 400), without changing other routes' JSON errors.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  const isJsonSyntax =
    err instanceof SyntaxError &&
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: number }).status === 400;
  if (
    isJsonSyntax &&
    req.method === "POST" &&
    (req.path === "/api/dataset/notifications" ||
      req.path === "/api/dataset/setup")
  ) {
    if (req.path === "/api/dataset/setup") {
      res.status(400).json({ error: "Invalid JSON body." });
      return;
    }
    req.body = {};
    next();
    return;
  }
  next(err);
});

// Public liveness probe. Must remain unauthenticated.
app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(createAuthRouter());
app.use(createLateralSyncHistoryRouter());
app.use(createLateralFiltersRouter());
app.use(createLateralPRolesRouter());
app.use(createHomeWidgetsRouter());
app.use(createNotificationsRouter());
app.use(createDatasetSyncHistoryRouter());
app.use(createDatasetSetupRouter());
app.use(createDatasetDriveMetadataRouter());
app.use(createDatasetConnectionsRouter());
app.use(createDatasetCurrentRouter());
app.use(createDatasetDriveFoldersRouter());
app.use(createLateralProcessingSetupRouter());

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
