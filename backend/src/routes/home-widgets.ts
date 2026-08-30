import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import { getHomeDashboardWidgets } from "../services/home-widgets.js";

/**
 * GET /api/home/widgets
 * Matches Next.js src/app/api/home/widgets/route.ts (postgres-mode semantics).
 */
export function createHomeWidgetsRouter(): Router {
  const router = Router();

  router.get(
    "/api/home/widgets",
    requireAccess("authenticated"),
    async (req, res) => {
      try {
        const refreshRaw = Array.isArray(req.query.refresh)
          ? req.query.refresh[0]
          : req.query.refresh;
        const bypassCache = refreshRaw === "1";
        const payload = await getHomeDashboardWidgets({ bypassCache });
        res
          .status(200)
          .set(
            "Cache-Control",
            "private, max-age=60, stale-while-revalidate=120"
          )
          .json(payload);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to build home widgets";
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
