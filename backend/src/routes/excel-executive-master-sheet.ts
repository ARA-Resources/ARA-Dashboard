import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import {
  DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE,
  EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS,
  type ExecutiveMasterDateFilter,
  type ExecutiveMasterPageSize,
} from "../services/excel/executive-master-sheet.js";
import {
  getExecutiveMasterFilterSchema,
  queryExecutiveMasterSheet,
} from "../services/excel/read-executive-master-sheet.js";

const NO_STORE = { "Cache-Control": "no-store" };

function parsePageSize(raw: string | undefined): ExecutiveMasterPageSize {
  const n = Number(raw);
  if (
    EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS.includes(n as ExecutiveMasterPageSize)
  ) {
    return n as ExecutiveMasterPageSize;
  }
  return DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE;
}

function parseJsonRecord<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapErrorStatus(message: string): number {
  return /not found|could not be loaded|Missing|missing/i.test(message)
    ? 404
    : 500;
}

/**
 * Stage 27: GET /api/excel/executive-master-sheet
 * Supports ?schema=1 for filter schema on the same URL.
 */
export function createExcelExecutiveMasterSheetRouter(): Router {
  const router = Router();

  router.get(
    "/api/excel/executive-master-sheet",
    requireAccess("authenticated"),
    async (req, res) => {
      const bypassCache = req.query.refresh === "1";
      const schemaOnly = req.query.schema === "1";

      try {
        if (schemaOnly) {
          const schema = await getExecutiveMasterFilterSchema({
            bypassCache,
          });
          res.status(200).set(NO_STORE).json({ ok: true, schema });
          return;
        }

        const page = Math.max(
          1,
          Number(
            typeof req.query.page === "string"
              ? req.query.page
              : String(req.query.page ?? "1")
          ) || 1
        );
        const pageSize = parsePageSize(
          typeof req.query.pageSize === "string"
            ? req.query.pageSize
            : req.query.pageSize !== undefined
              ? String(req.query.pageSize)
              : undefined
        );
        const columnFilters = parseJsonRecord<Record<string, string[]>>(
          typeof req.query.columnFilters === "string"
            ? req.query.columnFilters
            : undefined,
          {}
        );
        const textFilters = parseJsonRecord<Record<string, string>>(
          typeof req.query.textFilters === "string"
            ? req.query.textFilters
            : undefined,
          {}
        );
        const dateFilters = parseJsonRecord<
          Record<string, ExecutiveMasterDateFilter>
        >(
          typeof req.query.dateFilters === "string"
            ? req.query.dateFilters
            : undefined,
          {}
        );

        const result = await queryExecutiveMasterSheet(
          {
            page,
            pageSize,
            columnFilters,
            textFilters,
            dateFilters,
          },
          { bypassCache }
        );

        res.status(200).set(NO_STORE).json({ ok: true, ...result });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Executive Master Sheet could not be loaded.";
        console.error("[api/excel/executive-master-sheet]", message);
        const status = mapErrorStatus(message);
        res.status(status).set(NO_STORE).json({ ok: false, error: message });
      }
    }
  );

  return router;
}
