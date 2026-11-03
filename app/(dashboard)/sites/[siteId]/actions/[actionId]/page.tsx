import { getUserIdFromCookies } from "@/lib/session-helper";
import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ siteId: string; actionId: string }>;
}

/**
 * Wave 6: the legacy action detail is removed. Work is read in the funnel's
 * Work queue, where every task carries the evidence chain that produced it.
 * The route stays so old links land somewhere sensible instead of a 404.
 */
export default async function ActionDetailPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");
  redirect(`/sites/${siteId}/work`);
}
