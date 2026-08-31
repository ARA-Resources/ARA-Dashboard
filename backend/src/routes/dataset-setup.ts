import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import {
  deleteDatasetSetup,
  getDatasetSetupResponse,
  postDatasetSetup,
} from "../services/dataset-setup.js";

/**
 * GET/POST/DELETE /api/dataset/setup — matches Next route handler contract.
 * Scheduler reload remains Next-owned; Node returns scheduler: null.
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

  router.post(
    "/api/dataset/setup",
    requireAccess("operator"),
    async (req, res) => {
      try {
        const result = await postDatasetSetup(req.body);
        if (!result.ok) {
          res.status(result.status).json({
            error: result.error,
            ...(result.requiresReauth
              ? { requiresReauth: result.requiresReauth }
              : {}),
          });
          return;
        }
        res.status(200).json(result.payload);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to save dataset setup.";
        res.status(500).json({ error: message });
      }
    }
  );

  router.delete(
    "/api/dataset/setup",
    requireAccess("operator"),
    async (_req, res) => {
      try {
        const payload = await deleteDatasetSetup();
        res.status(200).json(payload);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to reset dataset setup.";
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
