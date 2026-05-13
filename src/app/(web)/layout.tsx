import "~/styles/globals.css";

import type { Metadata } from "next";
import { Oxanium } from "next/font/google";
import { cn } from "~/lib/utils";

const oxanium = Oxanium({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Faceless Factory",
  description: "Minimal node-based AI workflow builder on Next.js and Vertex AI.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn("font-sans", oxanium.variable, "dark")}>
      <body>{children}</body>
    </html>
  );
}
