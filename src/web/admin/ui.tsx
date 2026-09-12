import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from 'react';

export const Button = ({ kind = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'danger' | 'plain' }) => (
  <button {...p} className={`min-h-11 rounded-xl px-4 text-base font-medium disabled:opacity-40 ${
    kind === 'primary' ? 'bg-black text-white dark:bg-white dark:text-black' : kind === 'danger' ? 'bg-red-600 text-white' : kind === 'secondary' ? 'bg-neutral-200 dark:bg-neutral-800' : 'text-blue-600'} ${className}`} />);
export const Input = ({ label, className = '', ...p }: InputHTMLAttributes<HTMLInputElement> & { label?: string }) => (
  <label className="block"><span className="text-sm text-neutral-600 dark:text-neutral-400">{label}</span>
    <input {...p} className={`mt-1 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-base dark:border-neutral-700 dark:bg-neutral-900 ${className}`} /></label>);
export const Select = ({ label, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) => (
  <label className="block"><span className="text-sm text-neutral-600 dark:text-neutral-400">{label}</span>
    <select {...p} className="mt-1 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-base dark:border-neutral-700 dark:bg-neutral-900">{children}</select></label>);
export const Pill = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'amber' | 'green' | 'red' }) => (
  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${{ neutral: 'bg-neutral-200 dark:bg-neutral-800', blue: 'bg-blue-100 text-blue-800', amber: 'bg-amber-100 text-amber-800', green: 'bg-green-100 text-green-800', red: 'bg-red-100 text-red-800' }[tone]}`}>{children}</span>);
export const Card = ({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) => (
  <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-neutral-900"><div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">{title}</h2>{action}</div>{children}</section>);
export const Empty = ({ children }: { children: ReactNode }) => <p className="py-6 text-center text-neutral-500">{children}</p>;
export const Segmented = <T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) => (
  <div className="inline-flex rounded-lg bg-neutral-200 p-0.5 text-sm dark:bg-neutral-800" role="tablist">
    {options.map(([v, label]) => <button key={v} role="tab" aria-selected={value === v} onClick={() => onChange(v)} className={`min-h-9 rounded-md px-3 ${value === v ? 'bg-white shadow dark:bg-neutral-600' : ''}`}>{label}</button>)}
  </div>);
export function Toast({ msg, onDone }: { msg: string | null; onDone: () => void }) {
  if (!msg) return null;
  setTimeout(onDone, 3500);
  return <div role="status" className="fixed inset-x-4 bottom-20 z-50 mx-auto max-w-md rounded-xl bg-black px-4 py-3 text-white shadow-lg dark:bg-white dark:text-black md:bottom-6">{msg}</div>;
}
export const Row = ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
  <div onClick={onClick} className={`flex min-h-12 items-center gap-3 border-b border-neutral-200 py-2 last:border-0 dark:border-neutral-800 ${onClick ? 'cursor-pointer' : ''}`}>{children}</div>);
