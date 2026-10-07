import { redirect } from "next/navigation";
import { getSession } from "@/lib/server/auth";

export default async function Home() {
  redirect((await getSession()) ? "/dashboard" : "/login");
}
