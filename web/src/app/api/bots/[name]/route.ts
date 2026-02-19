import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDb, persist } from "@/lib/db";
import { getContainerStatus, destroyBot, getBotLogs } from "@/lib/docker";

// GET /api/bots/:name — bot detail
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  try {
    const session = await requireAuth();
    const { name } = await params;
    const db = await getDb();

    const query = session.role === "admin"
      ? "SELECT b.*, u.email as owner_email FROM bots b JOIN users u ON u.id = b.user_id WHERE b.name = ?"
      : "SELECT * FROM bots WHERE name = ? AND user_id = ?";

    const p = session.role === "admin" ? [name] : [name, session.userId];
    const result = db.exec(query, p);

    if (!result.length || !result[0].values.length) {
      return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    }

    const cols = result[0].columns;
    const row = result[0].values[0];
    const bot: any = {};
    cols.forEach((col: string, i: number) => {
      if (col === "telegram_token_enc" || col === "anthropic_key_enc") return;
      bot[col] = row[i];
    });
    bot.container_status = getContainerStatus(name);
    bot.has_custom_key = !!row[cols.indexOf("anthropic_key_enc")];

    return NextResponse.json(bot);
  } catch (e: any) {
    if (e.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE /api/bots/:name — destroy bot
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  try {
    const session = await requireAuth();
    const { name } = await params;
    const db = await getDb();

    // Check ownership (admin can delete any)
    if (session.role !== "admin") {
      const check = db.exec("SELECT id FROM bots WHERE name = ? AND user_id = ?", [name, session.userId]);
      if (!check.length || !check[0].values.length) {
        return NextResponse.json({ error: "Bot not found or not yours" }, { status: 404 });
      }
    }

    const result = destroyBot(name);
    if (result.error) return NextResponse.json(result, { status: 400 });

    db.run("DELETE FROM bots WHERE name = ?", [name]);
    persist();

    return NextResponse.json({ name, status: "destroyed" });
  } catch (e: any) {
    if (e.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
