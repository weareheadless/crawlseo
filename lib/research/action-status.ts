import type { ResearchActionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { updateResearchAction } from "@/lib/research/service";

/**
 * Move an action to VERIFIED after a delivery is confirmed. The path is walked
 * one status at a time because the action state machine does not allow a jump.
 */
export async function markActionVerified(actionId: string | null) {
  if (!actionId) return;
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    select: { id: true, status: true },
  });
  if (!action || ["VERIFIED", "FULFILLED", "DISMISSED", "FAILED"].includes(action.status)) return;

  const pathByStatus: Record<string, ResearchActionStatus[]> = {
    PROPOSED: ["APPROVED", "DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    APPROVED: ["DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    DRAFTING: ["DRAFT_READY", "DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    DRAFT_READY: ["DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    DELIVERY_APPROVED: ["DELIVERING", "DELIVERED", "VERIFIED"],
    DELIVERING: ["DELIVERED", "VERIFIED"],
    DELIVERED: ["VERIFIED"],
  };
  for (const status of pathByStatus[action.status] ?? []) {
    await updateResearchAction(action.id, { status }, "agent-deploy");
  }
}
