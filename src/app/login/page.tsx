"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserSupabase } from "@/lib/supabase-browser";

function signInError(error: unknown): string {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  const message = error instanceof Error ? error.message : "";
  if ((typeof status === "number" && status >= 500) || /HTTP 5\d\d|timeout|timed out|fetch|network/i.test(message)) {
    return "Sign-in is temporarily unavailable. Please try again in a few minutes.";
  }
  if (status === 429) return "Too many attempts. Please wait a minute before trying again.";
  if (/invalid login credentials/i.test(message)) {
    return "The email or password is incorrect. If you used a sign-in link before, you can still use one below.";
  }
  return message || "We couldn’t sign you in. Please try again.";
}

export default function Login() {
  const router = useRouter();
  const emailInput = useRef<HTMLInputElement>(null);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<"password" | "link" | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy("password");
    setMessage("");
    setFailed(false);
    try {
      const client = browserSupabase();
      const credentials = { email: email.trim(), password };
      const { data, error } = creatingAccount
        ? await client.auth.signUp({ ...credentials, options: { emailRedirectTo: `${window.location.origin}/auth/callback` } })
        : await client.auth.signInWithPassword(credentials);
      if (error) throw error;
      if (data.session) {
        router.replace("/");
        router.refresh();
      } else {
        setMessage("Check your email to confirm your account, then sign in.");
      }
    } catch (error) {
      setFailed(true);
      setMessage(signInError(error));
    } finally {
      setBusy(null);
    }
  };
  const sendLink = async () => {
    if (busy || !emailInput.current?.reportValidity()) return;
    setBusy("link");
    setMessage("");
    setFailed(false);
    try {
      const { error } = await browserSupabase().auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      setMessage("Check your email for a sign-in link.");
    } catch (error) {
      setFailed(true);
      setMessage(signInError(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <main className="auth-page">
      <div className="auth-card">
        <Link className="brand" href="/">
          Apply<span>.</span>
        </Link>
        <h1>{creatingAccount ? "Create your account" : "Welcome back"}</h1>
        <p className="auth-description">{creatingAccount ? "Keep your profile, saved roles and applications in one place." : "Sign in to your career workspace."}</p>
        <form onSubmit={submit} aria-busy={Boolean(busy)}>
          <label>
            Email address
            <input
              ref={emailInput}
              name="email"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              disabled={Boolean(busy)}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label htmlFor="password">Password</label>
          <div className="auth-password">
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete={creatingAccount ? "new-password" : "current-password"}
              required
              minLength={creatingAccount ? 6 : undefined}
              disabled={Boolean(busy)}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={creatingAccount ? "password-hint" : undefined}
            />
            <button className="auth-password-toggle" type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
          {creatingAccount && <p className="auth-hint" id="password-hint">Use at least 6 characters.</p>}
          <button className="dark-button" type="submit" disabled={Boolean(busy)}>
            {busy === "password" ? (creatingAccount ? "Creating account…" : "Signing in…") : (creatingAccount ? "Create account" : "Sign in")}
          </button>
          {!creatingAccount && <button className="auth-text-button auth-magic-link" type="button" disabled={Boolean(busy)} onClick={sendLink}>{busy === "link" ? "Sending link…" : "Email me a sign-in link instead"}</button>}
        </form>
        {message && <p className={`auth-message${failed ? " auth-message-error" : ""}`} role={failed ? "alert" : "status"}>{message}</p>}
        <p className="auth-switch">
          {creatingAccount ? "Already have an account?" : "New to Apply?"}{" "}
          <button className="auth-text-button" type="button" disabled={Boolean(busy)} onClick={() => { setCreatingAccount(!creatingAccount); setPassword(""); setShowPassword(false); setMessage(""); setFailed(false); }}>
            {creatingAccount ? "Sign in" : "Create an account"}
          </button>
        </p>
      </div>
    </main>
  );
}
