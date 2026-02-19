"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

interface Bot {
  id: string;
  name: string;
  status: string;
  container_status: string;
  model: string;
  telegram_owner_id: string;
  has_custom_key: boolean;
  created_at: string;
  owner_email?: string;
}

interface User {
  userId: string;
  email: string;
  role: string;
}

export default function DashboardPage() {
  const [user, setUser] = useState<User | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [showSpawn, setShowSpawn] = useState(false);
  const [showLogs, setShowLogs] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const fetchBots = useCallback(async () => {
    const res = await fetch("/api/bots");
    if (!res.ok) return;
    const data = await res.json();
    setBots(data.bots);
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/auth/me");
      if (!res.ok) { router.push("/login"); return; }
      const data = await res.json();
      setUser(data);
      await fetchBots();
      setLoading(false);
    })();
  }, [router, fetchBots]);

  // Refresh every 10s
  useEffect(() => {
    const interval = setInterval(fetchBots, 10000);
    return () => clearInterval(interval);
  }, [fetchBots]);

  async function botAction(name: string, action: "start" | "stop" | "restart") {
    await fetch(`/api/bots/${name}/${action}`, { method: "POST" });
    setTimeout(fetchBots, 2000);
  }

  async function destroyBot(name: string) {
    if (!confirm(`Permanently delete bot "${name}" and all its data?`)) return;
    await fetch(`/api/bots/${name}`, { method: "DELETE" });
    fetchBots();
  }

  async function viewLogs(name: string) {
    setShowLogs(name);
    const res = await fetch(`/api/bots/${name}/logs?lines=200`);
    const data = await res.json();
    setLogs(data.logs || "No logs");
  }

  async function exportBot(name: string) {
    const res = await fetch(`/api/bots/${name}/export`);
    if (!res.ok) { alert("Export failed"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-export.tar.gz`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="container" style={{ textAlign: "center", paddingTop: 120 }}>Loading...</div>;

  return (
    <>
      <nav className="nav">
        <div className="nav-brand">🤖 <span>PRO</span>BOTS</div>
        <div className="nav-links">
          {user?.role === "admin" && <a href="/admin">Admin</a>}
          <span className="nav-user">{user?.email}</span>
        </div>
      </nav>

      <div className="container">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h1 style={{ fontSize: 18, color: "var(--white)" }}>My Bots</h1>
          <button className="btn btn-primary" onClick={() => setShowSpawn(true)}>+ Spawn Bot</button>
        </div>

        {bots.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">🤖</div>
            <div className="empty-text">No bots yet</div>
            <button className="btn btn-primary" onClick={() => setShowSpawn(true)}>Spawn your first bot</button>
          </div>
        ) : (
          bots.map((bot) => (
            <div className="card" key={bot.id}>
              <div className="card-header">
                <div>
                  <span className="card-title">{bot.name}</span>
                  {bot.owner_email && <span className="card-meta" style={{ marginLeft: 8 }}>{bot.owner_email}</span>}
                </div>
                <span className={`badge badge-${bot.container_status === "running" ? "running" : bot.container_status === "exited" ? "stopped" : "unknown"}`}>
                  {bot.container_status}
                </span>
              </div>
              <div className="card-meta" style={{ marginBottom: 8 }}>
                Model: {bot.model?.split("/").pop()} · Owner ID: {bot.telegram_owner_id} · API: {bot.has_custom_key ? "Custom" : "Master"} · Created: {bot.created_at?.split("T")[0]}
              </div>
              <div className="bot-actions">
                {bot.container_status !== "running" && <button className="btn btn-sm" onClick={() => botAction(bot.name, "start")}>▶ Start</button>}
                {bot.container_status === "running" && <button className="btn btn-sm" onClick={() => botAction(bot.name, "stop")}>⏹ Stop</button>}
                <button className="btn btn-sm" onClick={() => botAction(bot.name, "restart")}>↻ Restart</button>
                <button className="btn btn-sm" onClick={() => viewLogs(bot.name)}>📋 Logs</button>
                <button className="btn btn-sm" onClick={() => exportBot(bot.name)}>📦 Export</button>
                <button className="btn btn-sm btn-danger" onClick={() => destroyBot(bot.name)}>🗑 Delete</button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Spawn Modal */}
      {showSpawn && <SpawnModal onClose={() => { setShowSpawn(false); fetchBots(); }} />}

      {/* Logs Modal */}
      {showLogs && (
        <div className="modal-overlay" onClick={() => setShowLogs(null)}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <h2>Logs: {showLogs}</h2>
            <pre className="logs-pre">{logs}</pre>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setShowLogs(null)}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}

function SpawnModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [telegramToken, setTelegramToken] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("anthropic/claude-sonnet-4-20250514");
  const [soul, setSoul] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSpawn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          telegram_token: telegramToken,
          telegram_owner_id: ownerId,
          anthropic_key: apiKey || undefined,
          model,
          soul: soul || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Spawn New Bot</h2>
        <form onSubmit={handleSpawn}>
          <div className="form-group">
            <label className="label">Bot Name</label>
            <input className="input" placeholder="my-bot" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label className="label">Telegram Bot Token</label>
            <input className="input" placeholder="123456:ABC-DEF..." value={telegramToken} onChange={(e) => setTelegramToken(e.target.value)} required />
          </div>
          <div className="form-group">
            <label className="label">Your Telegram ID</label>
            <input className="input" placeholder="1310278446" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} required />
          </div>
          <div className="form-group">
            <label className="label">API Key (leave empty for master key)</label>
            <input className="input" placeholder="sk-ant-... (optional)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="label">Model</label>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="anthropic/claude-sonnet-4-20250514">Claude Sonnet 4</option>
              <option value="anthropic/claude-haiku-3-5-20241022">Claude Haiku 3.5</option>
              <option value="anthropic/claude-opus-4-6">Claude Opus 4</option>
            </select>
          </div>
          <div className="form-group">
            <label className="label">Soul / Personality (optional)</label>
            <textarea className="input" rows={3} placeholder="You are a helpful assistant..." value={soul} onChange={(e) => setSoul(e.target.value)} />
          </div>
          {error && <p style={{ color: "var(--red)", fontSize: 12, marginBottom: 12 }}>{error}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} disabled={loading}>
              {loading ? "Spawning..." : "🚀 Spawn"}
            </button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
