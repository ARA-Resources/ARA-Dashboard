import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import {
  listDriveExcelWorkbooksByName,
  listExcelWorkbooksInFolder,
  listWorkbookWorksheets,
} from "../services/lateral-processing/setup-validation.js";

function mapOAuthErrorStatus(message: string): number {
  return /OAuth|not connected|permission|forbidden/i.test(message) ? 401 : 500;
}

/**
 * Stage 29A: GET /api/dataset/lateral-processing/workbooks
 * GET /api/dataset/lateral-processing/worksheets
 */
export function createLateralProcessingDriveDiscoveryRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/lateral-processing/workbooks",
    requireAccess("authenticated"),
    async (req, res) => {
      const folderId =
        typeof req.query.folderId === "string"
          ? req.query.folderId.trim()
          : "";
      const query =
        typeof req.query.query === "string" ? req.query.query.trim() : "";

      if (!folderId && !query) {
        res.status(400).json({ error: "Provide either folderId or query." });
        return;
      }

      try {
        const files = folderId
          ? await listExcelWorkbooksInFolder(folderId)
          : await listDriveExcelWorkbooksByName(query);
        res.status(200).json({ files });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load workbooks.";
        res.status(mapOAuthErrorStatus(message)).json({ error: message });
      }
    }
  );

  router.get(
    "/api/dataset/lateral-processing/worksheets",
    requireAccess("authenticated"),
    async (req, res) => {
      const fileId =
        typeof req.query.fileId === "string" ? req.query.fileId.trim() : "";
      const fileName =
        typeof req.query.fileName === "string"
          ? req.query.fileName.trim()
          : "workbook.xlsx";

      if (!fileId) {
        res.status(400).json({ error: "fileId is required." });
        return;
      }

      try {
        const worksheets = await listWorkbookWorksheets(fileId, fileName);
        res.status(200).json({ worksheets });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to read worksheet names.";
        res.status(mapOAuthErrorStatus(message)).json({ error: message });
      }
    }
  );

  return router;
}
