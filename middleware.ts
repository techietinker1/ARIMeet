import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const PUBLIC_PATHS = ["/sign-in", "/sign-up"];

export default clerkMiddleware(async (auth, request) => {
  const pathname = request.nextUrl.pathname;

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path)) || pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  const { userId, redirectToSignIn } = await auth();

  if (!userId) {
    return redirectToSignIn();
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
