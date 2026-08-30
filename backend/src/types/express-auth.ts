import type { DashboardSession } from "../auth/session.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: DashboardSession;
  }
}
