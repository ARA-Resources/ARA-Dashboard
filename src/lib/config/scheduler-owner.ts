/**
 * Stage 23: which process owns lateral scheduler cron registration.
 * Default is "next" for rollback compatibility.
 */
export type SchedulerOwner = "next" | "worker";

export function getSchedulerOwner(): SchedulerOwner {
  const raw = process.env.ARA_SCHEDULER_OWNER?.trim().toLowerCase();
  if (raw === "worker") return "worker";
  return "next";
}

export function isWorkerProcess(): boolean {
  return process.env.ARA_WORKER_PROCESS?.trim() === "1";
}

/**
 * True only in the process that should register node-cron for lateral jobs.
 */
export function shouldThisProcessOwnLateralCron(): boolean {
  const owner = getSchedulerOwner();
  if (owner === "worker") return isWorkerProcess();
  return !isWorkerProcess();
}

export function schedulerOwnershipReason(): string {
  const owner = getSchedulerOwner();
  if (owner === "worker" && !isWorkerProcess()) {
    return "ARA_SCHEDULER_OWNER=worker (Worker process owns cron; this process does not arm)";
  }
  if (owner === "next" && isWorkerProcess()) {
    return "ARA_SCHEDULER_OWNER=next (Next owns cron; Worker process does not arm)";
  }
  if (owner === "worker" && isWorkerProcess()) {
    return "ARA_SCHEDULER_OWNER=worker (this Worker process owns cron)";
  }
  return "ARA_SCHEDULER_OWNER=next (this Next process owns cron)";
}
