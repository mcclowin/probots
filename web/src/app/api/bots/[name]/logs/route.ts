import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getBotLogs } from "@/lib/docker";

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  try {
    const session = await requireAuth();
    const { name } = await params;
    const db = await getDb();

    if (session.role !== "admin") {
      const check = db.exec("SELECT id FROM bots WHERE name = ? AND user_id = ?", [name, session.userId]);
      if (!check.length || !check[0].values.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const lines = parseInt(req.nextUrl.searchParams.get("lines") || "100");
    const logs = getBotLogs(name, lines);
    return NextResponse.json({ name, logs });
  } catch (e: any) {
    if (e.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
