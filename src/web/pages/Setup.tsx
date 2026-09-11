import { useState, type FormEvent } from 'react';
import { api } from '../api';

const input = 'mt-1 w-full rounded-xl border border-neutral-300 px-3 py-3 text-base dark:border-neutral-700 dark:bg-neutral-900';

export function Setup({ state }: { state: string }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [f, setF] = useState({ ownerEmail: '', studioName: '', smtpUrl: '', from: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state === 'awaiting_verification') return (
    <main className="mx-auto max-w-md p-6 pt-20"><h1 className="text-2xl font-semibold">Check your email</h1>
      <p className="mt-2 text-neutral-600 dark:text-neutral-400">We sent a sign-in link to the owner address. Open it to finish setup.</p></main>);
  if (!token) return (
    <main className="mx-auto max-w-md p-6 pt-20"><h1 className="text-2xl font-semibold">Setup</h1>
      <p className="mt-2 text-neutral-600 dark:text-neutral-400">Run <code>opengallery setup-token</code> on the server and open the URL it prints.</p></main>);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setMsg(null); setBusy(true);
    try {
      await api('/api/setup', { method: 'POST', body: JSON.stringify({ token, ownerEmail: f.ownerEmail, studioName: f.studioName, email: { type: 'smtp', url: f.smtpUrl, from: f.from } }) });
      window.location.href = '/';
    } catch (err) { setMsg((err as Error).message); setBusy(false); }
  };
  const field = (k: keyof typeof f, label: string, type = 'text', ph = '') => (
    <label className="block"><span className="text-sm text-neutral-600 dark:text-neutral-400">{label}</span>
      <input required type={type} placeholder={ph} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className={input} /></label>);
  return (
    <main className="mx-auto max-w-md p-6 pt-12"><h1 className="text-2xl font-semibold">Set up OpenGallery</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        {field('studioName', 'Studio name')}{field('ownerEmail', 'Your email', 'email')}
        {field('smtpUrl', 'SMTP URL', 'url', 'smtp://user:pass@host:587')}{field('from', 'From address', 'text', 'Studio <hello@studio.com>')}
        {msg && <p className="text-sm text-red-600">{msg}</p>}
        <button disabled={busy} className="w-full rounded-xl bg-black py-3 text-base font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black">Send my sign-in link</button>
      </form></main>);
}
