/**
 * Node.js-only instrumentation. Must never be imported from Edge/middleware.
 * Starts Dataset + Lateral + Executive schedulers when the Node.js runtime
 * boots (dev + production). Windows-only Run All remains in its existing
 * modules.
 *
 * SCOPE: Lateral and Executive each have their own dedicated scheduler
 * (`lateral-scheduler.ts` / `executive-scheduler.ts`), fully independent of
 * each other (separate advisory locks, config tables, and env-var gates —
 * see `executive-scheduler.ts`'s module doc). The legacy multi-dataset
 * scheduler still boots but does not arm Consulting cron (not built yet).
 * Executive's cron only actually arms when BOTH `ARA_EXECUTIVE_SCHEDULER=1`
 * AND `executive_scheduler_state.enabled=true` are explicitly set — both
 * default off, so bootstrapping this function is safe on a fresh deploy.
 */
export async function registerNodeInstrumentation() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  try {
    const {
      assertProductionConfig,
      logProductionConfigStatus,
    } = await import("@/lib/config/runtime");
    const { logDatasetSchedulerPolicy } = await import(
      "@/lib/config/scheduler-policy"
    );
    logProductionConfigStatus();
    logDatasetSchedulerPolicy();
    assertProductionConfig();
    installShutdownHandlers();
  } catch (error) {
    console.error("[instrumentation] Production configuration check failed", error);
    throw error;
  }

  try {
    const { startDatasetScheduler } = await import(
      "@/services/dataset/scheduler"
    );
    await startDatasetScheduler();
    console.info(
      "[instrumentation] Dataset scheduler bootstrap complete (legacy multi-dataset cron disarmed; Lateral-only execution)."
    );
  } catch (error) {
    console.error("[instrumentation] Dataset scheduler failed to start", error);
  }

  try {
    const { getSchedulerOwner } = await import("@/lib/config/scheduler-owner");
    if (getSchedulerOwner() === "worker") {
      console.info(
        "[instrumentation] Lateral scheduler not started (ARA_SCHEDULER_OWNER=worker; Worker process owns cron)."
      );
    } else {
      const { startLateralScheduler } = await import(
        "@/services/lateral-processing/lateral-scheduler"
      );
      await startLateralScheduler();
      console.info("[instrumentation] Lateral scheduler bootstrap complete.");
    }
  } catch (error) {
    console.error("[instrumentation] Lateral scheduler failed to start", error);
  }

  try {
    const { getSchedulerOwner } = await import("@/lib/config/scheduler-owner");
    if (getSchedulerOwner() === "worker") {
      console.info(
        "[instrumentation] Executive scheduler not started (ARA_SCHEDULER_OWNER=worker; Worker process owns cron)."
      );
    } else {
      const { startExecutiveScheduler } = await import(
        "@/services/executive-processing/executive-scheduler"
      );
      await startExecutiveScheduler();
      console.info("[instrumentation] Executive scheduler bootstrap complete.");
    }
  } catch (error) {
    console.error("[instrumentation] Executive scheduler failed to start", error);
  }
}

function installShutdownHandlers() {
  const g = globalThis as typeof globalThis & { __araShutdown?: boolean };
  if (g.__araShutdown) return;
  g.__araShutdown = true;

  const stop = () => {
    void import("@/services/lateral-processing/lateral-scheduler").then(
      (mod) => {
        mod.stopLateralScheduler();
        console.info("[instrumentation] Lateral scheduler stopped.");
      }
    );
    void import("@/services/executive-processing/executive-scheduler").then(
      (mod) => {
        mod.stopExecutiveScheduler();
        console.info("[instrumentation] Executive scheduler stopped.");
      }
    );
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
