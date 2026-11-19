// 觸及預測分數（回測用）：把「高觸及帳號有、我們沒有」的差異寫成可以量化的規則。
// 不是演算法本身，只用來比較兩版 Prompt 寫出來的東西，哪一版比較接近高觸及貼文的特徵。
import { SENSITIVE_HOOK, STOCK_OPENERS } from './gemini';
import { similarity } from './ideate';

const ANCHOR = /\d|[A-Za-z]{2,}|月底|月初|發薪|薪水|帳單|昨天|今天|今晚|上週|這週|週末|過年|春節|中秋|聖誕|雙11|雙十一|開學|畢業|迎新|期末|颱風|演唱會|音樂祭|發表會|開箱/;

export interface ReachScore { total: number; anchor: number; noStock: number; noSensitive: number; question: number; density: number; novelty: number }

export function reachScore(parts: string[], others: string[] = [], finance = false): ReachScore {
  const p1 = (parts[0] ?? '').replace(/\s+/g, ' ');
  const p12 = `${p1} ${parts[1] ?? ''}`;
  // 最後一則後半是系統加的 CTA；問句通常在最後一兩則
  const near = parts.slice(-2).join(' ').replace(/https?:\/\/\S+/g, '');
  const anchor = ANCHOR.test(p1) ? 25 : 0;
  const noStock = STOCK_OPENERS.some((w) => p1.includes(w)) ? 0 : 20;
  const noSensitive = finance && SENSITIVE_HOOK.some((w) => p12.includes(w)) ? 0 : 15;
  const question = /[？?]/.test(near) ? 15 : 0;
  const len = [...p1].length;
  const density = len >= 25 && len <= 90 ? 10 : len >= 15 ? 5 : 0;
  const sim = others.length ? Math.max(...others.map((o) => similarity(p1, o))) : 0;
  const novelty = Math.round(15 * (1 - Math.min(1, sim)));
  return { total: anchor + noStock + noSensitive + question + density + novelty, anchor, noStock, noSensitive, question, density, novelty };
}
