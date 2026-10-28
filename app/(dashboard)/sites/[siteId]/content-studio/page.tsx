import { redirect } from "next/navigation";

type Props = { params: Promise<{ siteId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Keep bookmarked Content Studio URLs working while making Work the canonical action queue. */
export default async function ContentStudioCompatibility({ params, searchParams }: Props) {
  const [{ siteId }, query] = await Promise.all([params, searchParams]);
  const preserved = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) preserved.append(key, item);
  }
  const qs = preserved.toString();
  redirect(`/sites/${siteId}/work${qs ? `?${qs}` : ""}`);
}
