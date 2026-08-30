import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { buildLateralPRolesOpenings } from "../services/lateral-p-roles.js";
import type {
  OpeningsFilters,
  SortDirection,
} from "../types/lateral-p-roles.js";

/**
 * Parse query params to match Next.js
 * src/app/api/dataset/lateral/p-roles/route.ts
 */
function parseFilters(query: Record<string, unknown>): OpeningsFilters {
  const filters: OpeningsFilters = {
    columnFilters: {},
    sortBy: null,
    sortDirection: "desc",
    topN: null,
  };

  const rawColumnFilters = Array.isArray(query.columnFilters)
    ? query.columnFilters[0]
    : query.columnFilters;
  if (typeof rawColumnFilters === "string") {
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
    const sortByRaw = Array.isArray(query.sortBy) ? query.sortBy[0] : query.sortBy;
    const sortBy = typeof sortByRaw === "string" ? sortByRaw : "";
    filters.sortBy = sortBy.length > 0 ? sortBy : null;
  } else {
    filters.sortBy = null;
  }

  if (Object.prototype.hasOwnProperty.call(query, "sortDir")) {
    const sortDirRaw = Array.isArray(query.sortDir)
      ? query.sortDir[0]
      : query.sortDir;
    if (sortDirRaw === "asc" || sortDirRaw === "desc") {
      filters.sortDirection = sortDirRaw as SortDirection;
    }
  }
  if (!filters.sortDirection) {
    filters.sortDirection = "desc";
  }

  if (Object.prototype.hasOwnProperty.call(query, "top")) {
    const topRaw = Array.isArray(query.top) ? query.top[0] : query.top;
    const topText = topRaw == null ? "" : String(topRaw);
    if (topText === "" || topText === "all" || topText === "null") {
      filters.topN = null;
    } else {
      const top = Number(topText);
      filters.topN =
        Number.isFinite(top) && top > 0 ? Math.min(top, 500) : null;
    }
  } else {
    filters.topN = null;
  }

  return filters;
}

export function createLateralPRolesRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/lateral/p-roles",
    requireAccess("authenticated"),
    async (req, res) => {
      try {
        const filters = parseFilters(req.query as Record<string, unknown>);
        const result = await buildLateralPRolesOpenings(filters);
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(result);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to build lateral P-Roles dataset.";
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
