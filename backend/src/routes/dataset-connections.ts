import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { getSharedGoogleConnectionStatus } from "../services/dataset-connections.js";
import { clearGmailAuth } from "../services/gmail-oauth-read.js";

/**
 * GET /api/dataset/connections — shared Google connection status.
 * DELETE /api/dataset/connections — disconnect shared Google account (Stage 22).
 */
export function createDatasetConnectionsRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/connections",
    requireAccess("authenticated"),
    async (_req, res) => {
      try {
        const status = await getSharedGoogleConnectionStatus({
          probeDrive: true,
        });
        res.status(200).json(status);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load connection status.";
        res.status(500).json({ error: message });
      }
    }
  );

  router.delete(
    "/api/dataset/connections",
    requireAccess("operator"),
    async (_req, res) => {
      try {
        await clearGmailAuth();
        const status = await getSharedGoogleConnectionStatus({
          probeDrive: false,
        });
        res.status(200).json(status);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to disconnect Google account.";
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
