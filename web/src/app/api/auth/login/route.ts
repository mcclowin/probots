import { NextRequest, NextResponse } from "next/server";
import { sendOTP } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 });

    const resp = await sendOTP(email);
    return NextResponse.json({ ok: true, method_id: resp.email_id });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
