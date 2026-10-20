import { DiscardHeldPrint } from "./print-hold";
import { RetryableSendError } from "./tcp-sender";

/** Fail closed: cached bytes require a fresh server decision before retry. */
export async function authorizeHeldDelivery(serverUrl: string, jobId: string, agentKey: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/print/${encodeURIComponent(jobId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentKey}` },
      body: JSON.stringify({ action: "validate" }),
      signal: AbortSignal.timeout(4_000),
    });
    if (response.status === 404) throw new DiscardHeldPrint("Ticket no longer exists");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as {
      success?: boolean;
      data?: { allowed?: boolean; retry?: boolean; reason?: string };
    } | null;
    if (body?.success !== true || typeof body?.data?.allowed !== "boolean") throw new Error("Invalid validation response");
    if (body.data.allowed) return;
    if (body.data.retry === true) throw new Error(body.data.reason ?? "Printing paused");
    throw new DiscardHeldPrint(body.data.reason ?? "Ticket no longer eligible");
  } catch (error) {
    if (error instanceof DiscardHeldPrint) throw error;
    // No printer connection has been attempted; safe to retry this CHECK.
    throw new RetryableSendError(`Cannot confirm held ticket: ${(error as Error).message}`);
  }
}
