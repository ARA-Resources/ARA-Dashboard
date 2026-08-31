import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { getSharedGoogleConnectionStatus } from "../services/dataset-connections.js";

/**
 * GET /api/dataset/connections — shared Google connection status (read-only).
 * DELETE remains on Next.js.
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

  return router;
}
