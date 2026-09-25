import Providers from "@/components/providers";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import type { PropsWithChildren } from "react";

import "@stream-io/video-react-sdk/dist/css/styles.css";
import "react-datepicker/dist/react-datepicker.css";

import { siteConfig } from "@/config";
import { cn } from "@/lib/utils";

import "./globals.css";

const inter = Inter({ subsets: ["latin"] });


export const viewport: Viewport = {
  themeColor: "#0E78F9",
  colorScheme: "dark",
};

export const metadata: Metadata = siteConfig;

const AppLayout = ({ children }: Readonly<PropsWithChildren>) => {
  return (
    <html lang="en">
      <head />

      <body className={cn("bg-dark-2", inter.className)}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
};

export default AppLayout;
