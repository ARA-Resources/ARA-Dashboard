import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { getLateralDashboardFilterSchemaFromPostgres } from "../services/lateral-filters.js";

export function createLateralFiltersRouter(): Router {
  const router = Router();

  router.get(
    "/api/excel/lateral/filters",
    requireAccess("authenticated"),
    async (_req, res) => {
      try {
        const schema = await getLateralDashboardFilterSchemaFromPostgres();
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(schema);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to discover filters";
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
