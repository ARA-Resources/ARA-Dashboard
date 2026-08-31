import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { readDriveMetaStore } from "../services/dataset-drive-metadata.js";

/**
 * GET /api/dataset/drive/metadata — read-only encrypted store; no Google Drive API.
 */
export function createDatasetDriveMetadataRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/drive/metadata",
    requireAccess("authenticated"),
    async (_req, res) => {
      try {
        const store = await readDriveMetaStore();
        res.status(200).json(store);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load Drive metadata.";
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
