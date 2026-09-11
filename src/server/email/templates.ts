export type TemplateName = 'magic_link' | 'test_delivery';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const shell = (title: string, body: string) =>
  `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#111"><h1 style="font-size:20px">${esc(title)}</h1>${body}</body></html>`;

const T: Record<TemplateName, (v: Record<string, string>) => { subject: string; text: string; html: string }> = {
  magic_link: (v) => ({
    subject: `Sign in to ${v.studio}`,
    text: `Tap to sign in to ${v.studio}:\n\n${v.url}\n\nThis link works once and expires soon. If you did not request it, ignore this email.`,
    html: shell(`Sign in to ${v.studio ?? ''}`, `<p><a href="${esc(v.url ?? '')}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;border-radius:10px;text-decoration:none">Sign in</a></p><p style="color:#666;font-size:13px">This link works once and expires soon.</p>`),
  }),
  test_delivery: (v) => ({
    subject: `${v.studio}: email delivery works`,
    text: `This is a test message from ${v.studio}. Email is configured correctly.`,
    html: shell(`${v.studio ?? ''}: email delivery works`, `<p>Email is configured correctly.</p>`),
  }),
};
export function renderTemplate(name: TemplateName, vars: Record<string, string>) { return T[name](vars); }
