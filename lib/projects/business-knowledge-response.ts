export type BusinessKnowledgeErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "ORIGIN_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "VALIDATION_FAILED"
  | "UNAVAILABLE";

export function businessKnowledgeError(
  status: number,
  code: BusinessKnowledgeErrorCode,
  message: string,
  retryable = false,
): Response {
  return Response.json({
    schemaVersion: "business-knowledge/1",
    kind: "error",
    code,
    message: message.slice(0, 1000),
    retryable,
  }, { status, headers: { "cache-control": "no-store" } });
}
