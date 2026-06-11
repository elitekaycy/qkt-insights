import { useState } from "react";
import { login } from "../api";

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await login(password);
    setBusy(false);
    if (ok) onLoggedIn();
    else setError(true);
  };

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950">
      <form onSubmit={submit} className="w-80 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h1 className="text-lg font-semibold text-zinc-100">qkt insights</h1>
        <p className="mt-1 text-sm text-zinc-500">Admin password to continue</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(false);
          }}
          className="mt-4 w-full rounded bg-zinc-800 p-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-zinc-600"
          placeholder="password"
        />
        {error && <p className="mt-2 text-sm text-red-400">Wrong password</p>}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="mt-4 w-full rounded bg-zinc-100 p-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
