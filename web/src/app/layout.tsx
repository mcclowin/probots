import "./globals.css";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "ProBots",
  description: "Home server bot manager",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
