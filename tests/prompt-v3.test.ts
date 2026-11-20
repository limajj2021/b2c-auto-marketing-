// Prompt v3（觸及規則）與格式檢查、觸及預測分數
import { describe, expect, it } from 'vitest';
import { buildPrompt, wellFormed } from '../src/ai/gemini';
import { reachScore } from '../src/ai/reach';

const brand: any = { id: 'b1', name: '安流', industry: 'general', description: '資金規劃與借貸諮詢', timezone: 'Asia/Taipei' };
const s: any = { services: '借貸', audience: '上班族', content_tone: '直接', content_topics: '[]', banned_words: '[]', fact_bank: '', style_preset: '', thread_min: 4, thread_max: 7, cta_text: '', line_add_url: '' };

describe('prompt v3', () => {
  it('v3 adds reach rules, finance hook guard and recent hooks; v2 stays as before', () => {
    const v3 = buildPrompt(brand, s, { variant: 'v3', recent: ['月底帳單那篇的開頭'] });
    expect(v3).toContain('具體錨點'); expect(v3).toContain('借錢'); expect(v3).toContain('月底帳單那篇的開頭'); expect(v3).toContain('不要用品牌名稱');
    expect(v3).not.toContain('2 萬 8'); // 不放會被照抄的例子
    const v2 = buildPrompt(brand, s, { variant: 'v2' });
    expect(v2).not.toContain('具體錨點');
  });

  it('format check catches broken JSON and a whole thread crammed into one part', () => {
    expect(wellFormed('{"parts":["a","b","c"]}', 2)).toBe(true);
    expect(wellFormed('{"parts":["只有一則很長的內容"]}', 2)).toBe(false);
    expect(wellFormed('{ "parts": [ 收到"', 2)).toBe(false);
    expect(wellFormed('純文字舊格式', 1)).toBe(true);
  });

  it('reach score prefers concrete, non-template, question-ending threads', () => {
    const weak = reachScore(['🔍資金調度其實只在乎三件事', '1️⃣', '加 LINE https://x'], [], true);
    const strong = reachScore(['開學前一週，房租和學費撞在同一天，你先付哪個？', '情境', '你遇過嗎？\n加 LINE https://x'], [], true);
    expect(strong.total).toBeGreaterThan(weak.total + 30);
  });
});
