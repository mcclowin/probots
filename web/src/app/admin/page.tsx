"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface AdminUser {
  id: string;
  email: string;
  role: string;
  created_at: string;
  bot_count: number;
}

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      // Check auth + admin
      const me = await fetch("/api/auth/me");
      if (!me.ok) { router.push("/login"); return; }
      const user = await me.json();
      if (user.role !== "admin") { router.push("/dashboard"); return; }

      const res = await fetch("/api/admin/users");
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
      }
      setLoading(false);
    })();
  }, [router]);

  if (loading) return <div className="container" style={{ textAlign: "center", paddingTop: 120 }}>Loading...</div>;

  return (
    <>
      <nav className="nav">
        <div className="nav-brand">🤖 <span>PRO</span>BOTS <span style={{ color: "var(--red)", fontSize: 10 }}>ADMIN</span></div>
        <div className="nav-links">
          <a href="/dashboard">Dashboard</a>
        </div>
      </nav>

      <div className="container">
        <h1 style={{ fontSize: 18, color: "var(--white)", marginBottom: 24 }}>Users</h1>

        {users.length === 0 ? (
          <div className="empty">
            <div className="empty-text">No users yet</div>
          </div>
        ) : (
          users.map((u) => (
            <div className="card" key={u.id}>
              <div className="card-header">
                <span className="card-title">{u.email}</span>
                <span className={`badge ${u.role === "admin" ? "badge-running" : "badge-unknown"}`}>{u.role}</span>
              </div>
              <div className="card-meta">
                Bots: {u.bot_count} · Joined: {u.created_at?.split("T")[0]}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
