import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";

import { getPrisma } from "@/lib/prisma";

export async function GET() {
  try {
    const prisma = getPrisma();
    const user = await currentUser();

    if (!user) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const u: any = user;
    const userEmail =
      u?.primaryEmailAddress?.emailAddress ||
      u?.emailAddresses?.[0]?.emailAddress ||
      u?.email ||
      "";

    if (!userEmail) {
      return NextResponse.json({ meetings: [] });
    }

    const meetings = await prisma.meeting.findMany({
      where: { createdById: userEmail },
      orderBy: { scheduledFor: "desc" },
    });

    return NextResponse.json({ meetings });
  } catch (error) {
    console.error("GET /api/meetings error", error);
    return new NextResponse("Server error", { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const prisma = getPrisma();
    const body = await request.json();
    const { roomId, topic, description, hostEmail, scheduledFor } = body as {
      roomId?: string;
      topic?: string;
      description?: string;
      hostEmail?: string;
      scheduledFor?: string;
    };

    if (!roomId || !scheduledFor) {
      return NextResponse.json({
        success: false,
        message: "Missing required fields",
      });
    }

    const user = await currentUser();
    const u: any = user;
    const userEmail =
      u?.primaryEmailAddress?.emailAddress ||
      u?.emailAddresses?.[0]?.emailAddress ||
      u?.email ||
      "";

    const effectiveHostEmail =
      hostEmail?.trim() || userEmail || "anonymous-host";

    // If the client sent a topic but no description, call the local
    // Python T5 server to generate a richer description paragraph.
    let finalDescription: string | undefined = description;

    const trimmedTopic = typeof topic === "string" ? topic.trim() : "";
    if ((!finalDescription || !finalDescription.trim()) && trimmedTopic) {
      try {
        const pythonServiceUrl =
          process.env.PYTHON_SERVICE_URL || "http://127.0.0.1:5001";
        const res = await fetch(`${pythonServiceUrl}/topic-description`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: trimmedTopic }),
        });

        if (res.ok) {
          const data = (await res.json()) as
            | { description?: string | null }
            | undefined;

          if (data && typeof data.description === "string") {
            finalDescription = data.description;
          }
        } else {
          console.error(
            "topic-description HTTP error",
            res.status,
            await res.text()
          );
        }
      } catch (err) {
        console.error("Error calling topic-description:", err);
      }
    }

    // For now, use hostEmail as the creator identifier so that
    // meetings are still logically grouped per host without
    // requiring Clerk auth on this API.
    const createdById = hostEmail || "anonymous-host";

    const meeting = await prisma.meeting.create({
      data: {
        id: roomId,
        roomId,
        topic: trimmedTopic || null,
        description: finalDescription?.trim() || null,
        hostEmail: effectiveHostEmail,
        scheduledFor: new Date(scheduledFor),
        createdById: effectiveHostEmail,
      },
    });
    return NextResponse.json({ success: true, meeting });
  } catch (error: unknown) {
    console.error("POST /api/meetings error", error);

    const message =
      error instanceof Error && error.message
        ? error.message
        : "Server error";

    return NextResponse.json(
      { success: false, message },
      { status: 500 }
    );
  }
}
