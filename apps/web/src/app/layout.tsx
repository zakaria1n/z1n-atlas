import type { Metadata } from "next";
import "@/styles/globals.css";
import { RepositoryProvider } from "@/features/repository-import/repository-session";

export const metadata: Metadata = {
  title: "Z1N Atlas",
  description: "A source code atlas for understanding connections.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <RepositoryProvider>{children}</RepositoryProvider>
      </body>
    </html>
  );
}
