import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDb, persist, genId } from "@/lib/db";
import { spawnBot, getContainerStatus } from "@/lib/docker";

// GET /api/bots — list user's bots (admin sees all)
export async function GET() {
  try {
    const session = await requireAuth();
    const db = await getDb();

    const query = session.role === "admin"
      ? "SELECT b.*, u.email as owner_email FROM bots b JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC"
      : "SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC";

    const params = session.role === "admin" ? [] : [session.userId];
    const result = db.exec(query, params);

    if (!result.length) return NextResponse.json({ bots: [] });

    const cols = result[0].columns;
    const bots = result[0].values.map((row: any[]) => {
      const bot: any = {};
      cols.forEach((col: string, i: number) => {
        // Don't expose encrypted tokens
        if (col === "telegram_token_enc" || col === "anthropic_key_enc") return;
        bot[col] = row[i];
      });
      // Get live container status
      bot.container_status = getContainerStatus(bot.name);
      bot.has_custom_key = !!row[cols.indexOf("anthropic_key_enc")];
      return bot;
    });

    return NextResponse.json({ bots });
  } catch (e: any) {
    if (e.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/bots — spawn a new bot
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const body = await req.json();

    const { name, telegram_token, telegram_owner_id, anthropic_key, model, soul } = body;

    if (!name || !telegram_token || !telegram_owner_id) {
      return NextResponse.json({ error: "name, telegram_token, and telegram_owner_id required" }, { status: 400 });
    }

    // Spawn container
    const result = spawnBot({
      name,
      telegramToken: telegram_token,
      telegramOwnerId: telegram_owner_id,
      anthropicKey: anthropic_key || undefined,
      model,
      soul,
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // Record in DB
    const db = await getDb();
    const id = genId();
    db.run(
      `INSERT INTO bots (id, user_id, name, status, telegram_token_enc, telegram_owner_id, anthropic_key_enc, model, soul)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      [id, session.userId, name, telegram_token, telegram_owner_id, anthropic_key || null, model || "anthropic/claude-sonnet-4-20250514", soul || null]
    );
    persist();

    return NextResponse.json({ id, name, status: "running" }, { status: 201 });
  } catch (e: any) {
    if (e.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
