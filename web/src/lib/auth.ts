import { Client } from "stytch";
import { getDb, persist, genId } from "./db";
import { cookies } from "next/headers";

// Phase 2: Podman — rootless containers, better user isolation
// Phase 4: Terraform — provision cloud VMs for scaling beyond home server

let _stytch: Client | null = null;
function stytch(): Client {
  if (!_stytch) {
    _stytch = new Client({
      project_id: process.env.STYTCH_PROJECT_ID || "",
      secret: process.env.STYTCH_SECRET || "",
    });
  }
  return _stytch;
}

export async function sendOTP(email: string) {
  const resp = await stytch().otps.email.loginOrCreate({ email });
  return resp;
}

export async function verifyOTP(email: string, code: string) {
  const resp = await stytch().otps.authenticate({
    method_id: email,
    code,
    session_duration_minutes: 60 * 24 * 7, // 7 days
  });

  const db = await getDb();

  // Upsert user
  const existing = db.exec("SELECT id FROM users WHERE email = ?", [email]);
  let userId: string;

  if (existing.length && existing[0].values.length) {
    userId = existing[0].values[0][0] as string;
    db.run("UPDATE users SET stytch_user_id = ? WHERE id = ?", [
      resp.user_id,
      userId,
    ]);
  } else {
    userId = genId();
    // First user is admin
    const userCount = db.exec("SELECT COUNT(*) FROM users");
    const count = userCount[0]?.values[0]?.[0] as number;
    const role = count === 0 ? "admin" : "user";

    db.run(
      "INSERT INTO users (id, email, role, stytch_user_id) VALUES (?, ?, ?, ?)",
      [userId, email, role, resp.user_id]
    );
  }

  // Create session token
  const token = genId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [
    token,
    userId,
    expiresAt,
  ]);

  persist();
  return { token, userId };
}

export async function getSession(): Promise<{
  userId: string;
  email: string;
  role: string;
} | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("probots_session")?.value;
  if (!token) return null;

  const db = await getDb();
  const result = db.exec(
    `SELECT s.user_id, u.email, u.role FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
    [token]
  );

  if (!result.length || !result[0].values.length) return null;

  const [userId, email, role] = result[0].values[0] as [string, string, string];
  return { userId, email, role };
}

export async function requireAuth() {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  return session;
}

export async function requireAdmin() {
  const session = await requireAuth();
  if (session.role !== "admin") throw new Error("Forbidden");
  return session;
}
