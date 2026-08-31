/**
 * Stage 23: ARA Dashboard worker — lateral scheduler cron ownership only.
 * Separate process from Next.js and Node API. No HTTP server.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

process.env.ARA_WORKER_PROCESS = "1";

function resolveRepoRoot(): string {
  const cwd = process.cwd();
  const rootMarker = path.join("src", "app");
  if (existsSync(path.join(cwd, rootMarker))) {
    return cwd;
  }
  const parent = path.resolve(cwd, "..");
  if (existsSync(path.join(parent, rootMarker))) {
    return parent;
  }
  return cwd;
}

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const repoRoot = resolveRepoRoot();
process.chdir(repoRoot);
loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env.local"));

async function main(): Promise<void> {
  const { getSchedulerOwner } = await import("@/lib/config/scheduler-owner");
  const {
    datasetSchedulerPolicyReason,
    isDatasetSchedulerAutoEnabled,
  } = await import("@/lib/config/scheduler-policy");

  const owner = getSchedulerOwner();
  console.info("[worker] starting");
  console.info(`[worker] scheduler owner = ${owner}`);

  if (owner !== "worker") {
    console.info(
      "[worker] scheduler owner != worker; lateral scheduler disabled"
    );
  } else {
    const { startLateralScheduler } = await import(
      "@/services/lateral-processing/lateral-scheduler"
    );
    await startLateralScheduler();
    if (isDatasetSchedulerAutoEnabled()) {
      console.info("[worker] lateral scheduler armed");
    } else {
      console.info(
        `[worker] lateral scheduler not armed (${datasetSchedulerPolicyReason()})`
      );
    }
  }

  const shutdown = async (signal: string) => {
    console.info(`[worker] received ${signal}; stopping lateral scheduler`);
    const { stopLateralScheduler } = await import(
      "@/services/lateral-processing/lateral-scheduler"
    );
    stopLateralScheduler();
    console.info("[worker] lateral scheduler stopped");
    process.exit(0);
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[worker] fatal error:", message);
  process.exit(1);
});
