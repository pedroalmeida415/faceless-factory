import "~/styles/globals.css";

import type { Metadata } from "next";
import { Oxanium } from "next/font/google";
import { redirect } from "next/navigation";
import { cn } from "~/lib/utils";
import { getSession } from "~/main/auth/session";
import { TRPCReactProvider } from "~/main/trpc/react";

const oxanium = Oxanium({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Faceless Factory App",
  description: "Node-based AI workflow builder workspace.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default async function AppRootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();

  if (!session?.user) {
    redirect("/");
  }

  return (
    <html lang="en" className={cn("font-sans", oxanium.variable, "dark")}>
      <body>
        <TRPCReactProvider>{children}</TRPCReactProvider>
      </body>
    </html>
  );
}
