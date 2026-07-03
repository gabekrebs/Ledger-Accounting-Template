import type { Metadata } from "next";
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { AuthHeader } from "./auth-header";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display serif — section titles + hero figures. The "private-bank statement" voice.
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ledger Accounting Template",
  description: "Multi-entity bookkeeping and ledger",
  applicationName: "Ledger Accounting Template",
  metadataBase: new URL("https://your-app.example.com"),
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <AuthHeader />
        {children}
        <Toaster richColors expand position="top-right" />
      </body>
    </html>
  );
}
