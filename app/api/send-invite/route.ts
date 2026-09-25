import nodemailer from "nodemailer";
import { NextResponse } from "next/server";

function isValidEmail(email: string) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function escapeHtml(unsafe: string) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { meetingId, hostEmail, participantEmails } = body as {
      meetingId?: string;
      hostEmail?: string;
      participantEmails?: string[];
    };

    if (!meetingId || !hostEmail || !participantEmails || participantEmails.length === 0) {
      return NextResponse.json({
        success: false,
        message: "Missing required fields",
      });
    }

    if (!isValidEmail(hostEmail)) {
      return NextResponse.json({
        success: false,
        message: "Invalid host email format",
      });
    }

    const invalidEmails = participantEmails.filter((email) => !isValidEmail(email));
    if (invalidEmails.length > 0) {
      return NextResponse.json({
        success: false,
        message: `Invalid email format detected: ${invalidEmails.join(", ")}`,
      });
    }

    const baseUrl =
      process.env.APP_URL ||
      process.env.NEXT_PUBLIC_BASE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

    const meetingLink = `${baseUrl.replace(/\/$/, "")}/meeting?roomId=${encodeURIComponent(meetingId)}`;

    const emailPromises = participantEmails.map((email) => {
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: " You're Invited to Join a Meeting on Ari Meet",
        html: `
          <div style="font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px;">
            <div style="background: white; padding: 30px; border-radius: 10px; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #667eea;">You're Invited to a Meeting!</h2>
              <p style="color: #555; font-size: 14px;">
                <strong>${escapeHtml(hostEmail)}</strong> has invited you to join a meeting on <strong>Ari Meet</strong>.
              </p>

              <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 0 0 10px 0; color: #666;"><strong>Meeting ID:</strong></p>
                <p style="margin: 0; font-size: 18px; color: #667eea; font-weight: bold;">${escapeHtml(meetingId)}</p>
              </div>

              <div style="margin: 20px 0;">
                <a href="${meetingLink}" style="display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">
                  \ud83d\udd17 Join Meeting
                </a>
              </div>

              <p style="color: #999; font-size: 12px; margin-top: 30px;">
                Or paste this link in your browser: <br />
                <code style="background: #f0f0f0; padding: 5px;">${meetingLink}</code>
              </p>

              <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
              <p style="color: #999; font-size: 12px;">
                © 2026 Ari Meet. All rights reserved.
              </p>
            </div>
          </div>
        `,
      };

      return transporter.sendMail(mailOptions);
    });

    await Promise.all(emailPromises);

    return NextResponse.json({ success: true, message: "✅ Invites sent successfully!" });
  } catch (error: unknown) {
    console.error("Error in /api/send-invite:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, message: `Server error: ${message}` },
      { status: 500 }
    );
  }
}
