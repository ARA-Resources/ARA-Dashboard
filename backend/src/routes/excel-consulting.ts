import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { readConsultingTopOpenings } from "../services/excel/consulting-openings.js";
import { getConsultingFilterSchema } from "../services/excel/consulting-filter-schema.js";
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

export function createExcelConsultingRouter(): Router {
  const router = Router();

  router.get(
    "/api/excel/consulting",
    requireAccess("authenticated"),
    async (req, res) => {
      const bypassCache = req.query.refresh === "1";
      const filters = parseFilters(req.query);

      try {
        const data = await readConsultingTopOpenings(filters, { bypassCache });
        res.status(200).set(NO_STORE).json(data);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to read Excel source";
        res.status(500).set(NO_STORE).json({ error: message });
      }
    }
  );

  router.get(
    "/api/excel/consulting/filters",
    requireAccess("authenticated"),
    async (req, res) => {
      const bypassCache = req.query.refresh === "1";

      try {
        const schema = await getConsultingFilterSchema({ bypassCache });
        res.status(200).set(NO_STORE).json(schema);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to discover filters";
        res.status(500).set(NO_STORE).json({ error: message });
      }
    }
  );

  return router;
}
