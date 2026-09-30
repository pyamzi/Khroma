import { useState, type FormEvent } from 'react';
import { api } from '../api';

export function Signup() {
  const [email, setEmail] = useState(''); const [studioName, setStudioName] = useState(''); const [over18, setOver18] = useState(false); const [sent, setSent] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); await api('/api/signup', { method: 'POST', body: JSON.stringify({ email, studioName, over18 }) }); setSent(true); };
  const field = 'w-full rounded-xl border border-neutral-300 px-3 py-3 text-base dark:border-neutral-700 dark:bg-neutral-900';
  return (
    <main className="mx-auto max-w-md p-6 pt-24"><h1 className="text-3xl font-semibold">Create a studio</h1>
      {sent ? <p className="mt-4 text-neutral-600 dark:text-neutral-400">Check your email. The link signs you in to your studio.</p> : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <input required aria-label="Studio name" placeholder="Studio name" maxLength={80} value={studioName} onChange={(e) => setStudioName(e.target.value)} className={field} />
          <input required type="email" aria-label="Email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
          <label className="flex items-center gap-2 text-sm"><input required type="checkbox" checked={over18} onChange={(e) => setOver18(e.target.checked)} /> I am 18 or older</label>
          <button className="w-full rounded-xl bg-black py-3 text-base font-medium text-white dark:bg-white dark:text-black">Create studio</button>
          <p className="text-center text-sm"><a href="/signin" className="text-blue-600">Already have a studio? Sign in</a></p>
        </form>)}
    </main>);
}
