import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { readLateralDataProcessingSetup } from "../services/lateral-setup-store.js";
import { readLateralDataForPreview } from "../services/lateral-processing/data-reader.js";

function mapOAuthErrorStatus(message: string): number {
  return /OAuth|not connected|permission|forbidden/i.test(message) ? 401 : 500;
}

/**
 * Stage 30A: GET /api/dataset/lateral-processing/preview
 */
export function createLateralProcessingPreviewRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/lateral-processing/preview",
    requireAccess("authenticated"),
    async (_req, res) => {
      const setup = await readLateralDataProcessingSetup();
      if (!setup) {
        res.status(400).json({
          error:
            "Lateral Data Processing Setup is not configured. Complete the setup wizard first.",
        });
        return;
      }

      if (!setup.sourceWorkbook.fileId || !setup.masterWorkbook.fileId) {
        res.status(400).json({
          error:
            "Source workbook or master workbook is not selected in the setup. Reopen the setup wizard.",
        });
        return;
      }

      try {
        const result = await readLateralDataForPreview(setup);
        res.status(200).json({ ok: true, result });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to read workbook data.";
        res.status(mapOAuthErrorStatus(message)).json({ ok: false, error: message });
      }
    }
  );

  return router;
}
