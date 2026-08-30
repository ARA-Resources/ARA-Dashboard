import { Router } from "express";
import { listLateralSyncHistory } from "../services/lateral-sync-history.js";
import type { LateralSyncHistoryResponse } from "../types/lateral-sync-history.js";

/**
 * TEST-ONLY gate. Disabled unless ARA_STAGE4_ENABLE_READ_APIS=1.
 * Not production authentication. Full session/HMAC auth is a later stage.
 */
function isStage4ReadApiEnabled(): boolean {
  return process.env.ARA_STAGE4_ENABLE_READ_APIS === "1";
}

function parseLimit(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const limitRaw = Number(value ?? "100");
  return Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(500, Math.floor(limitRaw))
    : 100;
}

export function createLateralSyncHistoryRouter(): Router {
  const router = Router();

  router.get("/api/dataset/lateral/sync-history", async (req, res) => {
    if (!isStage4ReadApiEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    try {
      const limit = parseLimit(req.query.limit);
      const entries = await listLateralSyncHistory(limit);
      const body: LateralSyncHistoryResponse = {
        datasetName: "Lateral",
        entries,
        count: entries.length,
      };
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(body);
    } catch {
      res.status(503).json({ error: "Database unavailable" });
    }
  });

  return router;
}
