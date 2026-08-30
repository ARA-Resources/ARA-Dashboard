import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import {
  getSyncHistoryEntry,
  listSyncHistory,
  readSyncLogFile,
} from "../services/dataset-sync-history.js";

const NO_STORE = { "Cache-Control": "no-store" };

function parseLimit(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const limitRaw = Number(value ?? "100");
  return Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(500, Math.floor(limitRaw))
    : 100;
}

/**
 * GET /api/dataset/sync-history
 * GET /api/dataset/sync-history/:id/log
 *
 * Matches Next.js file-backed handlers (postgres dataset_sync_history unused).
 */
export function createDatasetSyncHistoryRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/sync-history",
    requireAccess("authenticated"),
    async (req, res) => {
      try {
        const limit = parseLimit(req.query.limit);
        const entries = await listSyncHistory(limit);
        res.status(200).set(NO_STORE).json({
          entries,
          count: entries.length,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load sync history";
        res.status(500).json({ error: message });
      }
    }
  );

  router.get(
    "/api/dataset/sync-history/:id/log",
    requireAccess("authenticated"),
    async (req, res) => {
      try {
        const id = String(req.params.id ?? "");
        const entry = await getSyncHistoryEntry(id);

        if (!entry) {
          res.status(404).json({
            error: "Sync history entry not found.",
          });
          return;
        }

        const logText = await readSyncLogFile(entry.logDay);
        if (logText && logText.trim().length > 0) {
          res
            .status(200)
            .set({
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Content-Disposition": `attachment; filename="dataset-sync-${entry.logDay}-${entry.dataset}.jsonl"`,
              "Cache-Control": "no-store",
            })
            .send(logText);
          return;
        }

        const fallback = JSON.stringify(
          {
            entry,
            note: "No JSONL sync log was found for this day. Returning the history entry.",
          },
          null,
          2
        );

        res
          .status(200)
          .set({
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="sync-history-${entry.id}.json"`,
            "Cache-Control": "no-store",
          })
          .send(fallback);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load sync history log";
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
