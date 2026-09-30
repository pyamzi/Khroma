import nodemailer from 'nodemailer';

/** One platform sender; each message carries its Studio's name and reply-to. */
export type Mail = { to: string; subject: string; text: string; html: string; messageId: string; fromName: string; replyTo: string | null };
export interface Transport { send(m: Mail): Promise<void>; describe(): string }

export function smtpTransport(url: string, fromAddress: string): Transport {
  const t = nodemailer.createTransport(url);
  return {
    describe: () => `smtp ${new URL(url).host}`,
    async send(m) {
      await t.sendMail({ from: { name: m.fromName, address: fromAddress }, replyTo: m.replyTo ?? undefined, to: m.to, subject: m.subject, text: m.text, html: m.html, messageId: m.messageId });
    },
  };
}

export function memoryTransport(): Transport & { sent: Mail[] } {
  const sent: Mail[] = [];
  return { sent, describe: () => 'memory', async send(m) { sent.push(m); } };
}
