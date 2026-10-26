export type BusinessKnowledgeErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "ORIGIN_CONFLICT"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "VALIDATION_FAILED"
  | "UNAVAILABLE";

export function businessKnowledgeError(
  status: number,
  code: BusinessKnowledgeErrorCode,
  message: string,
  retryable = false,
  currentRevision?: number,
): Response {
  return Response.json({
    schemaVersion: "business-knowledge/1",
    kind: "error",
    code,
    message: message.slice(0, 1000),
    retryable,
    ...(currentRevision === undefined ? {} : { currentRevision }),
  }, { status, headers: { "cache-control": "no-store" } });
}
