// AI 連接器（MCP，Streamable HTTP）：客戶在自己的 ChatGPT / Codex / Claude 裡用對話寫貼文。
// AI 用客戶自己的方案額度在他的對話裡寫；這裡只提供「讀品牌指南、讀寫草稿、確認後發布」這幾個動作。
// 每個動作都限定在通行證綁定的那一個品牌，伺服器端強制，不靠 AI 自律。
import { PATTERNS, appendCta, buildPrompt, postLink, tidyPart } from '../ai/gemini';
import { checkParts } from '../ai/compliance';
import { audit, forBrand, getBrand, getSettings, jsonArr } from '../db';
import { withCreds } from '../integrations';
import { publishNow } from '../threads/publishnow';
import { partsOf } from '../threads/scheduler';
import { normTopicTag } from '../threads/topic';
import { listAccounts, type Account } from '../threads/accounts';
import { iso, zonedToUtc } from '../util/time';
import { BATCH_MAX, batchSchedule } from '../threads/batch';
import type { Env } from '../types';
import { cors, verifyBearer, type McpActor } from './oauth';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_POSTS = 10, MAX_PARTS = 10, MAX_CHARS = 500;

const INSTRUCTIONS = `這是「異構資本」的 Threads 貼文助理連接器。寫貼文前一定先呼叫 get_brand_guide 取得這個品牌的資料與寫作規則，照規則寫。
寫好先在對話裡給使用者看，使用者同意後再用 save_drafts 存成草稿（一次最多 10 篇）。要寫很多篇時，每次 5 篇分批寫，品質比較穩定。
這個品牌有多個 Threads 帳號時，每個工具都可以用 account 參數指定帳號（例如 @vuca.tw）：save_drafts 存到指定帳號、update_draft 改到別的帳號、publish_post 發到指定帳號、schedule_posts 排到指定帳號。使用者說「發到某帳號」時直接帶 account，不要說做不到。
要把多篇草稿排程發出（可以分給多個帳號輪流發，或每個帳號都發）用 schedule_posts；排程前先把帳號、方式、開始時間、間隔講給使用者確認，同意後再把 confirm 設為 true。
不要自己編造數字、案例或引言。發布（publish_post）一定要使用者在對話中明確說要發布，並把 confirm 設為 true。`;

const TOOLS = [
  { name: 'get_brand_guide', title: '讀取品牌資料與寫作規則', description: '取得目前連接品牌的介紹、服務、受眾、語氣、主題、禁用詞、可引用數據、Threads 串文寫作與排版規則、結尾 CTA。寫任何貼文前先呼叫。',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: '這次想寫的主題（選填）' }, account: { type: 'string', description: '要用哪個 Threads 帳號的人設寫（選填，例如 @vuca.tw）' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'list_posts', title: '列出貼文', description: '列出這個品牌最近的貼文（草稿、已排程、已發布），回傳編號、狀態、第一句。',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['draft', 'scheduled', 'published', 'failed'] }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_post', title: '讀取一篇貼文', description: '取得一篇貼文的完整串文內容。',
    inputSchema: { type: 'object', properties: { post_id: { type: 'integer' } }, required: ['post_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'save_drafts', title: '存成草稿', description: '把寫好的貼文存進後台的待審核草稿（一次最多 10 篇；每篇是一串 Threads 串文，parts 每個元素是一則，最多 10 則、每則最多 500 字）。不要自己寫連結：系統會在最後一則自動加上品牌的 CTA 與 LINE 連結。',
    inputSchema: { type: 'object', properties: { posts: { type: 'array', minItems: 1, maxItems: MAX_POSTS, items: { type: 'object', properties: {
      parts: { type: 'array', minItems: 1, maxItems: MAX_PARTS, items: { type: 'string', maxLength: MAX_CHARS } },
      topic_tag: { type: 'string', description: 'Threads 主題標籤（選填，不含 #）；不填就用品牌預設' },
      account: { type: 'string', description: '要發到哪個 Threads 帳號（例如 @vuca.tw）。品牌有多個帳號時必填' } }, required: ['parts'], additionalProperties: false } } }, required: ['posts'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'update_draft', title: '修改草稿', description: '修改一篇還在待審核的草稿：可以整串取代內容（parts）、改主題標籤，或只用 account 改發到別的帳號（不用重傳內容）。',
    inputSchema: { type: 'object', properties: { post_id: { type: 'integer' }, parts: { type: 'array', minItems: 1, maxItems: MAX_PARTS, items: { type: 'string', maxLength: MAX_CHARS } }, topic_tag: { type: 'string' }, account: { type: 'string', description: '改發到哪個 Threads 帳號（例如 @vuca.tw）；不填就維持原本的帳號' } }, required: ['post_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'schedule_posts', title: '批量排程', description: `把多篇待審核草稿一次排程發到 Threads（一次最多 ${BATCH_MAX} 篇）。同一個品牌的多個帳號共用草稿池：mode=assign 每篇只發一次、輪流分給選的帳號（推薦）；mode=copy 每篇發到每個選的帳號（內容完全相同，可能被 Threads 視為重複）。從 start_at 開始，每篇間隔 interval_min 分鐘（0 代表同時發）。排好後時間到會自動公開發布，所以一定要使用者確認後才把 confirm 設為 true。`,
    inputSchema: { type: 'object', properties: {
      post_ids: { type: 'array', minItems: 1, maxItems: BATCH_MAX, items: { type: 'integer' }, description: '要排程的草稿編號（list_posts 的 #編號），依這個順序排時間' },
      accounts: { type: 'array', items: { type: 'string' }, description: '要發到哪些帳號（例如 ["@vuca.tw","@vuca.canada"]）；不填就用所有可發文的帳號' },
      mode: { type: 'string', enum: ['assign', 'copy'], description: 'assign＝輪流分配（預設）；copy＝每個帳號都發' },
      start_at: { type: 'string', description: '第一篇的發布時間，例如 2026-11-20 09:00（品牌所在時區）或含時區的 ISO 時間；不填＝現在（5 分鐘內開始）' },
      interval_min: { type: 'integer', minimum: 0, maximum: 1440, description: '每篇間隔幾分鐘，預設 30；0＝同時發' },
      confirm: { type: 'boolean', description: '使用者已確認帳號、方式與時間後才設為 true' } }, required: ['post_ids', 'confirm'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: 'publish_post', title: '立即發布到 Threads', description: '把一篇草稿或已排程的貼文立即發布到 Threads（公開，發出後無法收回）。可以用 account 指定要發到哪個帳號。只有在使用者明確說要發布時才使用，並把 confirm 設為 true。',
    inputSchema: { type: 'object', properties: { post_id: { type: 'integer' }, account: { type: 'string', description: '發到哪個 Threads 帳號（例如 @vuca.tw）；不填就發到這篇目前指定的帳號' }, confirm: { type: 'boolean', description: '使用者已明確同意立即發布時才設為 true' } }, required: ['post_id', 'confirm'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
];

class ToolError extends Error {}
const text = (t: string, structured?: unknown) => ({ content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) });
const needAdmin = (a: McpActor) => { if (a.role !== 'admin') throw new ToolError('你的帳號在這個品牌只有讀取權限，不能修改或發布貼文。'); };

function cleanParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) throw new ToolError('parts 必須是字串陣列');
  const out = parts.map((x) => tidyPart(String(x ?? ''))).filter(Boolean);
  if (!out.length) throw new ToolError('貼文內容是空的');
  if (out.length > MAX_PARTS) throw new ToolError(`一串最多 ${MAX_PARTS} 則`);
  const over = out.findIndex((x) => [...x].length > MAX_CHARS);
  if (over >= 0) throw new ToolError(`第 ${over + 1} 則超過 ${MAX_CHARS} 字（Threads 的上限），請縮短`);
  return out;
}
/** 加上 CTA 後再檢查一次長度（CTA 可能讓最後一則超過上限） */
const withCta = (parts: string[], cta: string, link: string) => {
  const out = appendCta(parts, cta, link);
  if ([...out[out.length - 1]].length > MAX_CHARS) throw new ToolError(`最後一則加上 CTA 與連結後超過 ${MAX_CHARS} 字，請把最後一則縮短一些`);
  return out;
};
const cleanTag = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const t = normTopicTag(v); if (t === null) throw new ToolError('主題標籤最多 50 字，不能有句點或 &'); return t;
};

/** 找出要發文的帳號：指定了就必須是這個品牌的帳號；沒指定用品牌預設（第一個） */
function pickAccount(accts: Account[], v: unknown): Account | null {
  if (v === undefined || v === null || String(v).trim() === '') return accts[0] ?? null;
  const want = String(v).trim().replace(/^@/, '').toLowerCase();
  const hit = accts.find((x) => (x.username ?? '').toLowerCase() === want);
  if (!hit) throw new ToolError(accts.length ? `這個品牌沒有 @${want}。可以用的帳號：${accts.map((x) => '@' + x.username).join('、')}` : '這個品牌還沒有連結 Threads 帳號');
  return hit;
}
const acctLabel = (a: Account | null | undefined) => (a?.username ? '@' + a.username : '預設帳號');

async function callTool(env: Env, a: McpActor, origin: string, name: string, args: any) {
  const brand = await getBrand(env), s = await getSettings(env, a.brandId), accts = await listAccounts(env);
  const review = `${origin}/#/posts`;
  switch (name) {
    case 'get_brand_guide': {
      const acct = args?.account ? pickAccount(accts, args.account) : null;
      const guide = buildPrompt(brand, s, { topic: args?.topic ? String(args.topic).slice(0, 200) : undefined, account: acct }).split('\n# 輸出')[0].trim();
      const acctList = accts.length ? accts.map((x, i) => `・@${x.username}${i === 0 ? '（預設）' : ''}${x.status !== 'ok' ? '（授權失效，暫時不能發文）' : ''}${x.persona ? `：${x.persona}` : ''}`).join('\n') : '（還沒有連結 Threads 帳號）';
      const link = postLink(s);
      return text(`${guide}

# 套路（每篇挑一個，不要連續重複）
${Object.values(PATTERNS).map((p) => `・${p.name}：${p.flow}`).join('\n')}

# Threads 帳號
${acctList}
${accts.length > 1 ? '・這個品牌有多個帳號：寫之前先問使用者要發到哪一個，存檔時用 account 指定；每個帳號的人設可能不同，可以用 get_brand_guide 的 account 參數取得該帳號的寫法。' : ''}

# 存檔
・寫好後用 save_drafts 存成草稿，每篇的 parts 是一則一則的串文。
・不要自己寫連結。系統會在最後一則加上：${[s.cta_text, link].filter(Boolean).join(' ') || '（這個品牌還沒設定 CTA 與 LINE 連結）'}
・每一篇都要給一個 topic_tag（Threads 主題標籤，2～12 字、跟這篇主題相關、不含 #）。品牌預設標籤：${s.topic_tag || '（無）'}；沒給的話會用品牌預設標籤，再沒有就用品牌名稱。
・存好後請使用者到後台審核：${review}`, { brand: brand.name, accounts: accts.map((x) => ({ username: x.username, persona: x.persona || null, active: x.status === 'ok' })), thread_min: s.thread_min, thread_max: s.thread_max, topic_tag: s.topic_tag || null, cta: s.cta_text, link });
    }
    case 'list_posts': {
      const st = ['draft', 'scheduled', 'published', 'failed'].includes(args?.status) ? args.status : null;
      const lim = Math.min(Math.max(Number(args?.limit) || 10, 1), 30);
      const rows = (await env.DB.prepare(`SELECT id,status,content,parts,scheduled_at,published_at,account_id FROM posts WHERE brand_id=? AND status<>'deleted' AND (? IS NULL OR status=?) ORDER BY id DESC LIMIT ?`)
        .bind(a.brandId, st, st, lim).all<any>()).results;
      const items = rows.map((r) => ({ id: r.id, status: r.status, account: acctLabel(accts.find((x) => x.id === r.account_id) ?? (r.account_id ? null : accts[0])), parts: partsOf(r).length, hook: String(r.content).split('\n')[0].slice(0, 60), scheduled_at: r.scheduled_at, published_at: r.published_at }));
      return text(items.length ? items.map((x) => `#${x.id}［${x.status}］${x.account}｜${x.hook}（${x.parts} 則）`).join('\n') : '沒有符合的貼文', { posts: items });
    }
    case 'get_post': {
      const r = await env.DB.prepare(`SELECT id,status,content,parts,topic_tag,error_message FROM posts WHERE id=? AND brand_id=? AND status<>'deleted'`).bind(Number(args?.post_id), a.brandId).first<any>();
      if (!r) throw new ToolError('找不到這篇貼文');
      const parts = partsOf(r);
      return text(`#${r.id}［${r.status}］${r.error_message ? `\n注意：${r.error_message}` : ''}\n\n${parts.map((p, i) => `【第 ${i + 1} 則】\n${p}`).join('\n\n')}`, { id: r.id, status: r.status, parts, topic_tag: r.topic_tag });
    }
    case 'save_drafts': {
      needAdmin(a);
      const posts = Array.isArray(args?.posts) ? args.posts : [];
      if (!posts.length) throw new ToolError('沒有要存的貼文');
      if (posts.length > MAX_POSTS) throw new ToolError(`一次最多存 ${MAX_POSTS} 篇`);
      const link = postLink(s), saved: { id: number; parts: number; account: string; issues: string[] }[] = [];
      const live = accts.filter((x) => x.status === 'ok');
      if (live.length > 1 && posts.some((p: any) => !p?.account)) throw new ToolError(`這個品牌有 ${live.map((x) => '@' + x.username).join('、')} 多個帳號，請先問使用者要存到哪一個，並在每篇的 account 填上帳號。`);
      const prepared = posts.map((p: any) => ({ parts: withCta(cleanParts(p?.parts), s.cta_text, link), tag: cleanTag(p?.topic_tag), acct: pickAccount(accts, p?.account) }));
      for (const p of prepared) {
        const issues = checkParts(p.parts, { industry: brand.industry, bannedWords: jsonArr(s.banned_words) });
        const r = await env.DB.prepare(`INSERT INTO posts(brand_id,account_id,content,parts,status,topic_tag,error_message,updated_at,created_at) VALUES(?,?,?,?,'draft',?,?,?,?)`)
          .bind(a.brandId, p.acct?.id ?? null, p.parts[0], JSON.stringify(p.parts), p.tag, issues.length ? `內容檢查未通過：${issues.join('；')}` : null, iso(), iso()).run();
        saved.push({ id: r.meta.last_row_id as number, parts: p.parts.length, account: acctLabel(p.acct), issues });
      }
      await audit(env, a.brandId, `${a.name}（${a.client}）`, 'mcp_save_drafts', saved.map((x) => x.id).join(','));
      const warn = saved.filter((x) => x.issues.length);
      return text(`已存成 ${saved.length} 篇草稿：${saved.map((x) => `#${x.id}（${x.account}）`).join('、')}。${warn.length ? `\n其中 ${warn.map((x) => `#${x.id}`).join('、')} 有內容需要修改：${warn.map((x) => x.issues.join('；')).join(' / ')}` : ''}\n請到後台審核：${review}`, { saved, review_url: review });
    }
    case 'update_draft': {
      needAdmin(a);
      const cur = await env.DB.prepare(`SELECT parts,content FROM posts WHERE id=? AND brand_id=? AND status='draft'`).bind(Number(args?.post_id), a.brandId).first<any>();
      if (!cur) throw new ToolError('只有待審核的草稿可以修改（找不到這篇草稿，或它已排程／發布）');
      if (args?.parts === undefined && args?.account === undefined && args?.topic_tag === undefined) throw new ToolError('沒有要修改的內容');
      const parts = args?.parts === undefined ? partsOf(cur) : withCta(cleanParts(args.parts), s.cta_text, postLink(s)), tag = args?.topic_tag === undefined ? undefined : cleanTag(args.topic_tag);
      const acct = args?.account === undefined ? undefined : pickAccount(accts, args.account);
      const issues = checkParts(parts, { industry: brand.industry, bannedWords: jsonArr(s.banned_words) });
      const r = await env.DB.prepare(`UPDATE posts SET content=?,parts=?,${tag !== undefined ? 'topic_tag=?,' : ''}${acct !== undefined ? 'account_id=?,' : ''}error_message=?,updated_at=? WHERE id=? AND brand_id=? AND status='draft'`)
        .bind(...[parts[0], JSON.stringify(parts), ...(tag !== undefined ? [tag] : []), ...(acct !== undefined ? [acct?.id ?? null] : []), issues.length ? `內容檢查未通過：${issues.join('；')}` : null, iso(), Number(args?.post_id), a.brandId]).run();
      if (r.meta.changes !== 1) throw new ToolError('只有待審核的草稿可以修改（找不到這篇草稿，或它已排程／發布）');
      await audit(env, a.brandId, `${a.name}（${a.client}）`, 'mcp_update_draft', String(args.post_id));
      return text(`已更新草稿 #${args.post_id}${acct ? `（帳號：${acctLabel(acct)}）` : ''}${issues.length ? `，但內容需要修改：${issues.join('；')}` : ''}`);
    }
    case 'schedule_posts': {
      needAdmin(a);
      if (args?.confirm !== true) throw new ToolError('排程前請先跟使用者確認要發到哪些帳號、輪流或每個帳號都發、從什麼時候開始、間隔多久，使用者同意後再把 confirm 設為 true。');
      const live = accts.filter((x) => x.status === 'ok');
      const names: unknown[] = Array.isArray(args?.accounts) ? args.accounts : [];
      const chosen = names.length ? names.map((n) => pickAccount(accts, n)!) : live;
      const dead = chosen.filter((x) => x.status !== 'ok');
      if (dead.length) throw new ToolError(`${dead.map((x) => '@' + x.username).join('、')} 的授權已失效，暫時不能發文，請使用者到後台重新連結`);
      let start: Date | null = null;
      if (args?.start_at !== undefined && args.start_at !== null && String(args.start_at).trim()) {
        const v = String(args.start_at).trim(), m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})$/);
        start = m ? zonedToUtc(m[1], m[2], brand.timezone) : new Date(v);
        if (isNaN(start.getTime())) throw new ToolError('start_at 看不懂，請用 2026-11-20 09:00 這種格式');
      }
      const r = await batchSchedule(env, a.brandId, `${a.name}（${a.client}）`, { postIds: args?.post_ids, accountIds: chosen.map((x) => x.id), mode: args?.mode, intervalMin: args?.interval_min ?? 30, start });
      if (!r.ok) throw new ToolError(r.error);
      const fmt = (t: string) => new Intl.DateTimeFormat('zh-TW', { timeZone: brand.timezone, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));
      return text(`已排程 ${r.scheduled} 次發文（${Object.entries(r.per_account).map(([k, n]) => `${k} ${n} 篇`).join('、')}）：
${r.plan.map((x) => `・${fmt(x.at)}　${x.account}　#${x.post_id}${x.copy ? '（複製）' : ''}`).join('\n')}${r.skipped.length ? `\n略過：${r.skipped.map((x) => `#${x.id} ${x.reason}`).join('；')}` : ''}
時間到會自動發布；要改時間或取消請到後台：${review}`, { ...r, timezone: brand.timezone, review_url: review });
    }
    case 'publish_post': {
      needAdmin(a);
      if (args?.confirm !== true) throw new ToolError('發布前請先跟使用者確認，使用者同意後再把 confirm 設為 true。');
      if (args?.account) {
        const acct = pickAccount(accts, args.account)!;
        if (acct.status !== 'ok') throw new ToolError(`@${acct.username} 的授權已失效，請使用者到後台重新連結`);
        const u = await env.DB.prepare(`UPDATE posts SET account_id=?,updated_at=? WHERE id=? AND brand_id=? AND status IN ('draft','scheduled')`).bind(acct.id, iso(), Number(args?.post_id), a.brandId).run();
        if (u.meta.changes !== 1) throw new ToolError('找不到這篇草稿或已排程的貼文（已發布的貼文不能換帳號）');
      }
      const r = await publishNow(env, a.brandId, `${a.name}（${a.client}）`, Number(args?.post_id));
      if ('error' in r) throw new ToolError(r.error);
      return text(r.status === 'published' ? `已發布到 Threads（${r.total} 則）` : r.message!, r);
    }
  }
  throw new ToolError(`沒有這個工具：${name}`);
}

async function handleMessage(env: Env, a: McpActor, origin: string, m: any): Promise<unknown | null> {
  const id = m?.id, isReq = id !== undefined && id !== null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return fail(-32600, 'Invalid Request');
  if (!isReq) return null; // 通知（例如 notifications/initialized）不用回
  switch (m.method) {
    case 'initialize': {
      const v = m.params?.protocolVersion;
      return ok({ protocolVersion: PROTOCOLS.includes(v) ? v : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ego-office-posts', title: '異構資本 貼文助理', version: '1.0.0' }, instructions: `${INSTRUCTIONS}\n目前連接的品牌：${a.brandName}` });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: a.role === 'admin' ? TOOLS : TOOLS.filter((t) => t.annotations.readOnlyHint) });
    case 'tools/call': {
      try { return ok(await callTool(env, a, origin, String(m.params?.name ?? ''), m.params?.arguments ?? {})); }
      catch (e) { if (e instanceof ToolError) return ok({ content: [{ type: 'text', text: e.message }], isError: true }); throw e; }
    }
  }
  return fail(-32601, `Method not found: ${m.method}`);
}

export async function handleMcp(raw: Env, req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method === 'DELETE') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST', ...cors } });
  const actor = await verifyBearer(raw, req);
  if (!actor) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: {
    'content-type': 'application/json', ...cors, 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
  const env = await withCreds({ ...forBrand(raw, actor.brandId), MEMO: new Map() } as Env);
  const body: any = await req.json().catch(() => undefined);
  if (body === undefined) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400, headers: cors });
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map((m) => handleMessage(env, actor, origin, m)))).filter((x) => x !== null);
  if (!out.length) return new Response(null, { status: 202, headers: cors });
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors } });
}
