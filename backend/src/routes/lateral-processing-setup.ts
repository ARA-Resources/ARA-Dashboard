import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { getLateralProcessingSetupResponse } from "../services/lateral-processing-setup.js";

/**
 * Stage 24: GET /api/dataset/lateral-processing/setup only.
 * POST remains on Next.js — no rewrite in this stage.
 */
export function createLateralProcessingSetupRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/lateral-processing/setup",
    requireAccess("authenticated"),
    async (_req, res) => {
      try {
        const payload = await getLateralProcessingSetupResponse();
        res.status(200).json(payload);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load Lateral Dataset Setup.";
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
