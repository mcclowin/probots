import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    await requireAdmin();
    const db = await getDb();

    const result = db.exec(`
      SELECT u.id, u.email, u.role, u.created_at,
        (SELECT COUNT(*) FROM bots WHERE user_id = u.id) as bot_count
      FROM users u ORDER BY u.created_at DESC
    `);

    if (!result.length) return NextResponse.json({ users: [] });

    const cols = result[0].columns;
    const users = result[0].values.map((row: any[]) => {
      const u: any = {};
      cols.forEach((col: string, i: number) => u[col] = row[i]);
      return u;
    });

    return NextResponse.json({ users });
  } catch (e: any) {
    if (e.message === "Forbidden") return NextResponse.json({ error: "Admin only" }, { status: 403 });
    if (e.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
