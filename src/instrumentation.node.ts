/**
 * Node.js-only instrumentation. Must never be imported from Edge/middleware.
 * Starts Dataset + Lateral schedulers when the Node.js runtime boots
 * (dev + production). Windows-only Run All remains in its existing modules.
 *
 * SCOPE: Only Lateral executes jobs currently (dedicated Lateral scheduler).
 * The legacy multi-dataset scheduler boots but does not arm Exec/Consulting crons.
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
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
