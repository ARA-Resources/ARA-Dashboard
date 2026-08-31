import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import {
  buildExecutivePDashboardOpenings,
  getExecutivePDashboardFilterSchema,
} from "../services/excel/executive-p-dashboard-service.js";
import type { OpeningsFilters, SortDirection } from "../types/filters.js";

const NO_STORE = { "Cache-Control": "no-store" };

function parseFilters(query: Record<string, unknown>): Partial<OpeningsFilters> {
  const filters: Partial<OpeningsFilters> = {};

  const rawColumnFilters = query.columnFilters;
  if (typeof rawColumnFilters === "string" && rawColumnFilters) {
    try {
      const parsed = JSON.parse(rawColumnFilters) as Record<string, string[]>;
      if (parsed && typeof parsed === "object") {
        filters.columnFilters = parsed;
      }
    } catch {
      filters.columnFilters = {};
    }
  }

  if (Object.prototype.hasOwnProperty.call(query, "sortBy")) {
    const sortBy =
      typeof query.sortBy === "string" ? query.sortBy : String(query.sortBy ?? "");
    filters.sortBy = sortBy.length > 0 ? sortBy : null;
  }

  if (Object.prototype.hasOwnProperty.call(query, "sortDir")) {
    const sortDir =
      typeof query.sortDir === "string" ? query.sortDir : String(query.sortDir ?? "");
    if (sortDir === "asc" || sortDir === "desc") {
      filters.sortDirection = sortDir as SortDirection;
    }
  }

  if (Object.prototype.hasOwnProperty.call(query, "top")) {
    const topRaw =
      typeof query.top === "string" ? query.top : String(query.top ?? "");
    if (topRaw === "" || topRaw === "all" || topRaw === "null") {
      filters.topN = null;
    } else {
      const top = Number(topRaw);
      filters.topN =
        Number.isFinite(top) && top > 0 ? Math.min(top, 500) : null;
    }
  }

  return filters;
}

/**
 * Stage 26: GET /api/excel/executive-p-dashboard
 * Supports ?schema=1 for filter schema on the same URL.
 */
export function createExcelExecutivePDashboardRouter(): Router {
  const router = Router();

  router.get(
    "/api/excel/executive-p-dashboard",
    requireAccess("authenticated"),
    async (req, res) => {
      const bypassCache = req.query.refresh === "1";
      const schemaOnly = req.query.schema === "1";

      try {
        if (schemaOnly) {
          const schema = await getExecutivePDashboardFilterSchema({
            bypassCache,
          });
          res.status(200).set(NO_STORE).json({ ok: true, schema });
          return;
        }

        const filters = parseFilters(req.query);
        const result = await buildExecutivePDashboardOpenings(filters, {
          bypassCache,
        });
        res.status(200).set(NO_STORE).json({ ok: true, ...result });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to build Executive P-Dashboard.";
        console.error("[api/excel/executive-p-dashboard]", message);
        res.status(500).set(NO_STORE).json({ ok: false, error: message });
      }
    }
  );

  return router;
}
