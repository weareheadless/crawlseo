import { redirect } from "next/navigation";
import { getUserIdFromCookies } from "@/lib/session-helper";

export default async function Home() {
  const userId = await getUserIdFromCookies();
  redirect(userId ? "/dashboard" : "/login");
}
