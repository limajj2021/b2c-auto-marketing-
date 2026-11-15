// 品牌資料包：給客戶自己的 AI 用的指令，以及解析 AI 整理好的結果
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 像瀏覽器一樣執行腳本（它會把 BrandKit 掛在 window 上）
const win: any = {};
new Function('window', readFileSync(new URL('../public/brandkit.js', import.meta.url), 'utf8'))(win);
const BrandKit: any = win.BrandKit;

const AI_OUTPUT = `好的，以下是整理好的品牌資料包：

\`\`\`
=== 品牌資料包 ===
[品牌名稱]
VUCA 剪輯團隊
[品牌介紹]
我們是專做短影音後製的剪輯團隊，
協助創作者與品牌把素材變成能留住觀眾的影片。
[產品與服務]
- 短影音剪輯：每支 30～60 秒
- 長片精剪：訪談、課程
- 字幕與包裝
[目標受眾]
想經營短影音但沒時間剪片的個人品牌與中小企業。
[品牌語氣]
專業但口語，不說教，偶爾幽默
[內容主題]
1. 剪輯技巧
2. 短影音留存率
3. 接案與報價
- 剪輯技巧
[禁用詞]
保證爆紅、最便宜、100% 有效
[寫作原則]
爭議化、數據化、具體化
[可引用數據]
- 前三秒決定 65% 的觀眾是否繼續看（某平台創作者報告 2025）
- 平均每支影片成本 3,000 元（待確認）
- [1] 完播率每提升 10%，推薦量約增加 20%（內部測試 2026）
[CTA 文字]
想知道你的影片卡在哪？加 LINE 讓我們幫你看
=== 結束 ===
\`\`\`

希望有幫到你！`;

describe('parsing the AI output', () => {
  it('extracts every field, ignoring chatter, code fences, bullets and numbering', () => {
    const r = BrandKit.parse(AI_OUTPUT);
    expect(r.found).toEqual(['name', 'description', 'services', 'audience', 'tone', 'topics', 'banned', 'style', 'facts', 'cta']);
    expect(r.fields.name).toBe('VUCA 剪輯團隊');
    expect(r.fields.description).toContain('短影音後製');
    expect(r.fields.services).toContain('短影音剪輯');
    expect(r.fields.topics).toEqual(['剪輯技巧', '短影音留存率', '接案與報價']);   // 去除編號與重複
    expect(r.fields.banned).toEqual(['保證爆紅', '最便宜', '100% 有效']);
    expect(r.fields.cta).toBe('想知道你的影片卡在哪？加 LINE 讓我們幫你看');
  });

  it('never uses unverified figures: "待確認" facts are dropped, and a [1] citation is not mistaken for a heading', () => {
    const r = BrandKit.parse(AI_OUTPUT);
    expect(r.fields.facts.split('\n')).toEqual([
      '前三秒決定 65% 的觀眾是否繼續看（某平台創作者報告 2025）',
      '[1] 完播率每提升 10%，推薦量約增加 20%（內部測試 2026）',
    ]);
    expect(r.skipped).toContainEqual({ key: 'facts', label: '可引用數據', reason: '1 筆待確認的數據未採用' });
  });

  it('is tolerant of bold headings, full-width brackets and inline values', () => {
    const r = BrandKit.parse('**【品牌名稱】** 阿福咖啡\n**【目標受眾】**：上班族、附近住戶\n【禁用詞】\n無\n【可引用數據】\n全部待確認\n【內容主題】咖啡豆知識，沖煮教學；門市日常');
    expect(r.fields).toEqual({ name: '阿福咖啡', audience: '上班族、附近住戶', topics: ['咖啡豆知識', '沖煮教學', '門市日常'] });
    expect(r.skipped.map((s: any) => s.key)).toEqual(['banned', 'facts']);
  });

  it('ignores the untouched template (placeholders) and unrelated text', () => {
    expect(BrandKit.parse(BrandKit.FORMAT).found).toEqual([]);
    expect(BrandKit.parse('我不知道要貼什麼').found).toEqual([]);
    expect(BrandKit.parse('').found).toEqual([]);
  });

  it('respects the server limits (truncates and reports)', () => {
    const r = BrandKit.parse(`[寫作原則]\n${'字'.repeat(900)}\n[內容主題]\n${Array.from({ length: 80 }, (_, i) => `主題${i}`).join('\n')}`);
    expect(r.fields.style.length).toBe(500); expect(r.truncated).toContain('寫作原則');
    expect(r.fields.topics.length).toBe(50);
  });
});

describe('merging with what the customer already has', () => {
  const current = { name: '舊名稱', description: '', topics: ['剪輯技巧', '客戶案例'], banned: [], facts: '舊數據 A（出處 1）', tone: '親切' };
  it('replaces text fields but merges lists and facts, so nothing the customer wrote is lost', () => {
    const items = BrandKit.plan(current, BrandKit.parse(AI_OUTPUT));
    const by = Object.fromEntries(items.map((i: any) => [i.key, i]));
    expect(by.name).toMatchObject({ kind: '更新', final: 'VUCA 剪輯團隊' });
    expect(by.description.kind).toBe('新增');
    expect(by.topics.final).toEqual(['剪輯技巧', '客戶案例', '短影音留存率', '接案與報價']); expect(by.topics.kind).toBe('補充');
    expect(by.facts.final.split('\n')[0]).toBe('舊數據 A（出處 1）'); expect(by.facts.final.split('\n').length).toBe(3);
    expect(BrandKit.plan({ ...current, name: 'VUCA 剪輯團隊' }, { fields: { name: 'VUCA 剪輯團隊' } })[0].kind).toBe('沒有變化');
  });
  it('builds the PUT /settings payload with the API field names', () => {
    const p = BrandKit.toPayload(BrandKit.plan(current, BrandKit.parse(AI_OUTPUT)));
    expect(Object.keys(p).sort()).toEqual(['audience', 'banned_words', 'content_tone', 'content_topics', 'cta_text', 'description', 'fact_bank', 'name', 'services', 'style_preset']);
    expect(Array.isArray(p.content_topics)).toBe(true);
  });
});

describe('the prompts handed to the customer', () => {
  it('are three, in order, and the output prompt asks for exactly the format the parser understands', () => {
    const ps = BrandKit.prompts({ current: { name: 'VUCA', topics: ['剪輯'] }, regulated: false });
    expect(ps.map((p: any) => p.id)).toEqual(['inventory', 'interview', 'output']);
    expect(ps[2].text).toContain(BrandKit.FORMAT);
    expect(ps[0].text).toContain('[品牌名稱] VUCA'); expect(ps[0].text).toContain('[禁用詞] （尚未填寫）');
    // 往返：照格式填好內容後，每個欄位都解析得回來
    const filled = BrandKit.FORMAT.split('\n').map((l: string) => (/^（/.test(l) ? '內容' + l.length : l)).join('\n');
    expect(BrandKit.parse(filled).found.length).toBe(10);
  });
  it('tell the AI not to invent numbers or include personal data, and add the compliance note for regulated industries', () => {
    const [, interview, output] = BrandKit.prompts({ current: {}, regulated: true });
    for (const t of [interview.text, output.text]) { expect(t).toContain('不要'); expect(t).toContain('待確認'); expect(t).toContain('利率'); }
    expect(output.text).toContain('個人資料');
    expect(BrandKit.prompts({ current: {}, regulated: false })[1].text).not.toContain('利率');
  });
});
