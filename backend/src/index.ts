import express from "express";
import { readDatabaseIdentity, selectOne } from "./db.js";
import { createLateralSyncHistoryRouter } from "./routes/lateral-sync-history.js";

const app = express();
const port = Number(process.env.PORT) || 3001;

app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(createLateralSyncHistoryRouter());

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
});
