import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { exportBot } from "@/lib/docker";

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  try {
    const session = await requireAuth();
    const { name } = await params;
    const db = await getDb();

    if (session.role !== "admin") {
      const check = db.exec("SELECT id FROM bots WHERE name = ? AND user_id = ?", [name, session.userId]);
      if (!check.length || !check[0].values.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const archive = exportBot(name);
    if (!archive) return NextResponse.json({ error: "Export failed" }, { status: 500 });

    return new NextResponse(new Uint8Array(archive), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${name}-export.tar.gz"`,
      },
    });
  } catch (e: any) {
    if (e.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
