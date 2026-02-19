"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    (async () => {
      const res = await fetch("/api/auth/me");
      if (res.ok) router.push("/dashboard");
      else router.push("/login");
    })();
  }, [router]);

  return (
    <div style={{ textAlign: "center", paddingTop: 120, color: "var(--dim)" }}>
      Redirecting...
    </div>
  );
}
