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
      return NextResponse.json({ success: true, items: [] });
    }

    const transcripts = await prisma.recordingtranscript.findMany({
      where: {
        recording: {
          meeting: {
            createdById: userEmail,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      include: {
        recording: {
          include: {
            meeting: true,
          },
        },
      },
      take: 100,
    });

    const items = transcripts.map((t: (typeof transcripts)[number]) => {
      const recording = t.recording;
      const meeting = recording.meeting;

      return {
        id: t.id,
        studentName: recording.userName || recording.userEmail || "Unknown",
        userEmail: recording.userEmail,
        meetingId: recording.meetingId,
        topic: meeting?.topic || meeting?.description || null,
        text: t.text,
        createdAt: t.createdAt,
      };
    });

    return NextResponse.json({ success: true, items });
  } catch (error) {
    console.error("GET /api/transcriptions error", error);
    return NextResponse.json(
      { success: false, message: "Server error" },
      { status: 500 }
    );
  }
}
