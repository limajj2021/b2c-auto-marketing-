import type { Env } from '../types';

export interface Reply {
  text: string;
  quick?: string[]; // LINE 快速回覆按鈕（message action）
}

export function toLineMessages(replies: Reply[]) {
  // Reply API 單次最多 5 則；快速回覆掛在最後一則
  const msgs: any[] = replies.slice(0, 5).map((r) => ({ type: 'text', text: r.text.slice(0, 4900) }));
  const lastQuick = replies[msgs.length - 1]?.quick;
  if (lastQuick?.length) {
    msgs[msgs.length - 1].quickReply = {
      items: lastQuick.slice(0, 13).map((l) => ({
        type: 'action', action: { type: 'message', label: l.slice(0, 20), text: l },
      })),
    };
  }
  return msgs;
}

export async function reply(env: Env, replyToken: string, replies: Reply[]): Promise<void> {
  if (!replies.length) return;
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: toLineMessages(replies) }),
  });
  if (!res.ok) throw new Error(`LINE reply HTTP ${res.status}`);
}

export async function getDisplayName(env: Env, userId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!res.ok) return null;
    return ((await res.json()) as any).displayName ?? null;
  } catch { return null; }
}
