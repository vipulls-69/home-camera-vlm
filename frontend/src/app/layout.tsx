import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono, Inter } from "next/font/google";
import "./globals.css";
import { NavBar } from "@/components/nav-bar";
import { AlertToaster } from "@/components/alert-toaster";
import { WebcamUploader } from "@/components/webcam-uploader";
import { Toaster } from "@/components/ui/sonner";

const fontSans = Space_Grotesk({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const fontMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const inter = Inter({
  subsets: ['latin'],
  display: 'swap', 
});


export const metadata: Metadata = {
  title: "AI Video Pipeline Dashboard",
  description: "Real-time home security camera monitoring dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.className} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-white text-foreground">
        <NavBar />
        <main className="flex-1">{children}</main>
        <AlertToaster />
        <WebcamUploader />
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}

