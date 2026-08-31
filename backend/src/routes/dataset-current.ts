import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { getDatasetCurrentResponse } from "../services/dataset-current.js";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/dataset/current — read-only filesystem listing.
 * ?seed=1 is not supported on Node (write path remains on Next rollback).
 */
export function createDatasetCurrentRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/current",
    requireAccess("authenticated"),
    async (req, res) => {
      if (req.query.seed === "1") {
        res.status(400).set(NO_STORE).json({
          error:
            "Seeding current datasets is not supported on the Node endpoint. Use the Next rollback route or remove ?seed=1.",
        });
        return;
      }

      try {
        const payload = await getDatasetCurrentResponse();
        res.status(200).set(NO_STORE).json(payload);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to list current datasets";
        res.status(500).set(NO_STORE).json({ error: message });
      }
    }
  );

  return router;
}
