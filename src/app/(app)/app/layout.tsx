import { redirect } from "next/navigation";

import { getSession } from "~/features/auth/server/session";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();

  if (!session?.user) {
    redirect("/");
  }

  return children;
}
