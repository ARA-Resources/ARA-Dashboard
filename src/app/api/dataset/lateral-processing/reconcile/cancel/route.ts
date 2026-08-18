import { NextResponse } from "next/server";
import { cancelReconciliationRollback } from "@/services/lateral-processing/master-reconcile";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST() {
  try {
    const result = await cancelReconciliationRollback();
    if (!result.ok) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to cancel and rollback.";
    const status = /OAuth|not connected|permission|forbidden/i.test(message)
      ? 401
      : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
