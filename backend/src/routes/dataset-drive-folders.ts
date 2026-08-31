import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { getDatasetDriveFoldersResponse } from "../services/dataset-drive-folders.js";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/dataset/drive/folders — local metadata only (non-live).
 * ?live=1 is not supported on Node (deferred to a later Google migration stage).
 */
export function createDatasetDriveFoldersRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/drive/folders",
    requireAccess("authenticated"),
    async (req, res) => {
      if (req.query.live === "1") {
        res.status(400).set(NO_STORE).json({
          error:
            "Live Google Drive folder statistics are not supported on the Node endpoint. Use the default request without ?live=1.",
        });
        return;
      }

      try {
        const payload = await getDatasetDriveFoldersResponse({ live: false });
        res.status(200).set(NO_STORE).json(payload);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load Drive folder statistics.";
        res.status(500).set(NO_STORE).json({ error: message });
      }
    }
  );

  return router;
}
