import { listGSCProperties } from "@/lib/google";
import { getUserIdFromCookies } from "@/lib/session-helper";

export async function GET() {
  try {
    const userId = await getUserIdFromCookies();

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const properties = await listGSCProperties(userId);

    return Response.json(properties);
  } catch (error) {
    console.error("Error listing GSC properties:", error);

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to list properties",
      },
      { status: 500 }
    );
  }
}
