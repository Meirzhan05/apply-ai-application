"use client";
import { useState } from "react";
import Link from "next/link";
import { browserSupabase } from "@/lib/supabase-browser";

export default function Login() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const client = browserSupabase();
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      setMessage("Check your email for a sign-in link.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-page">
      <div className="auth-card">
        <Link className="brand" href="/">
          Apply<span>.</span>
        </Link>
        <p className="eyebrow">YOUR CAREER WORKSPACE</p>
        <h1>Welcome back</h1>
        <p>Enter your email. We’ll send a secure sign-in link.</p>
        <form onSubmit={submit}>
          <label>
            Email address
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <button className="dark-button" disabled={busy}>
            {busy ? "Sending…" : "Send sign-in link"}
          </button>
        </form>
        {message && <p role="status">{message}</p>}
      </div>
    </main>
  );
}
