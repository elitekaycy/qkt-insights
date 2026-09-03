import { useState } from "react";
import { login, type LoginResult } from "../api";
import { Button, Input } from "../components/ui";
import { InstallApp } from "../components/InstallApp";
import { useBrand } from "../useBrand";

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<Exclude<LoginResult, "ok"> | null>(null);
  const [busy, setBusy] = useState(false);
  const brand = useBrand();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await login(username, password);
      if (result === "ok") onLoggedIn();
      else setError(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-ink">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60rem 30rem at 70% -10%, color-mix(in srgb, var(--color-accent) 7%, transparent), transparent), radial-gradient(40rem 24rem at 10% 110%, color-mix(in srgb, #a78bfa 6%, transparent), transparent)",
        }}
      />
      <form onSubmit={submit} className="rise relative w-[22rem] rounded-card border border-line bg-panel p-7">
        <div className="text-xl font-extrabold tracking-tight text-bright">
          qkt<span className="text-accent">·</span>insights
        </div>
        <p className="mt-1 text-sm text-muted">
          {brand ? (
            <>
              Sign in to <span className="font-semibold text-accent">{brand}</span>
            </>
          ) : (
            "Sign in to continue"
          )}
        </p>
        <Input
          type="text"
          autoFocus
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setError(null);
          }}
          className="mt-5 w-full"
          placeholder="username"
        />
        <Input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          className="mt-2.5 w-full"
          placeholder="password"
        />
        {error === "denied" && <p className="mt-2.5 text-sm text-down">Wrong username or password</p>}
        {error === "unreachable" && <p className="mt-2.5 text-sm text-warn">Can't reach the collector — check the connection and try again.</p>}
        <Button type="submit" variant="primary" disabled={busy || username.length === 0 || password.length === 0} className="mt-5 w-full py-2">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <InstallApp variant="login" />
      </form>
    </div>
  );
}
