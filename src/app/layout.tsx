import type { Metadata } from "next";
import { SessionRefresh } from "@/components/session-refresh";
import "./globals.css";
import "./auth.css";

export const metadata: Metadata = {
  title: "Apply · Your next opportunity",
  description:
    "Find relevant roles and review every application before it goes out.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><SessionRefresh />{children}</body>
    </html>
  );
}
