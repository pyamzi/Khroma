import { useState, type FormEvent } from 'react';
import { api } from '../api';

export function SignIn() {
  const [email, setEmail] = useState(''); const [sent, setSent] = useState(false);
  const expired = new URLSearchParams(window.location.search).get('error') === 'expired';
  const submit = async (e: FormEvent) => { e.preventDefault(); await api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email }) }); setSent(true); };
  return (
    <main className="mx-auto max-w-md p-6 pt-24"><h1 className="text-3xl font-semibold">Sign in</h1>
      {expired && <p className="mt-2 text-amber-700">That link has expired or was already used. Request a new one.</p>}
      {sent ? <p className="mt-4 text-neutral-600 dark:text-neutral-400">If that address is on file, a sign-in link is on its way.</p> : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <input required type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-neutral-300 px-3 py-3 text-base dark:border-neutral-700 dark:bg-neutral-900" />
          <button className="w-full rounded-xl bg-black py-3 text-base font-medium text-white dark:bg-white dark:text-black">Email me a link</button>
        </form>)}
    </main>);
}
