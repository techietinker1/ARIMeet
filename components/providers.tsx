"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { PropsWithChildren } from "react";

import { Toaster } from "@/components/ui/toaster";

export default function Providers({ children }: PropsWithChildren) {
  return (
    <ClerkProvider
      publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
    >
      {children}
      <Toaster />
    </ClerkProvider>
  );
}
