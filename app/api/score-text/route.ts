import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { topic, text } = body as {
      topic?: string;
      text?: string;
    };

    const trimmedTopic = (topic || "").trim();
    const trimmedText = (text || "").trim();

    if (!trimmedTopic || !trimmedText) {
      return NextResponse.json(
        { success: false, message: "Topic and text are required" },
        { status: 400 },
      );
    }

    const pythonServiceUrl =
      process.env.PYTHON_SERVICE_URL || "http://127.0.0.1:5001";
    const res = await fetch(`${pythonServiceUrl}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: trimmedTopic, transcript: trimmedText }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data?.error) {
      const message =
        (data && data.error) || `Python score HTTP error: ${res.status}`;
      return NextResponse.json(
        { success: false, message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      topic: data.topic ?? trimmedTopic,
      reference: data.reference ?? "",
      similarity: typeof data.similarity === "number" ? data.similarity : 0,
      score: typeof data.score === "number" ? data.score : 0,
    });
  } catch (error: unknown) {
    console.error("POST /api/score-text error", error);
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Server error";

    return NextResponse.json(
      { success: false, message },
      { status: 500 },
    );
  }
}
