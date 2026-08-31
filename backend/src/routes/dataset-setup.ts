import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { getDatasetSetupResponse } from "../services/dataset-setup.js";

/**
 * GET /api/dataset/setup — read-only; POST/DELETE remain on Next.
 */
export function createDatasetSetupRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/setup",
    requireAccess("authenticated"),
    async (_req, res) => {
      try {
        const payload = await getDatasetSetupResponse();
        res.status(200).json(payload);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load dataset setup.";
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
