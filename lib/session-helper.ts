import { cookies } from "next/headers";
import { db } from "./db";

/**
 * Reads the local session cookie and looks up the user in the database.
 */
export async function getUserIdFromCookies(): Promise<string | null> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("crawlseo.session-token")?.value ?? null;

  if (!sessionToken) return null;

  const session = await db.session.findUnique({
    where: { sessionToken },
    select: { userId: true, expires: true },
  });

  if (!session || session.expires < new Date()) return null;

  return session.userId;
}
