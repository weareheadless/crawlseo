export const profileFields = ["audience", "topics", "services", "competitors", "brandVoice", "constraints", "country", "language"] as const;
export function profileValue(value: unknown): string {
  if (value == null || value === "") return "Not recorded";
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "Not recorded";
  if (typeof value === "object") return Object.keys(value).length ? JSON.stringify(value) : "Not recorded";
  return String(value);
}
export function confirmationStatus(status: string): "confirmed" | "unconfirmed" {
  return ["owner_confirmed", "admin_confirmed", "verified"].includes(status) ? "confirmed" : "unconfirmed";
}
