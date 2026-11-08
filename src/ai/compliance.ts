import { REGULATED_INDUSTRIES } from '../types';

export const THREADS_MAX_CHARS = 500;

const ALWAYS_BANNED: RegExp[] = [
  /保證.{0,3}(核貸|過件|通過|下款|撥款|放款)/,
  /(百分之百|100\s*%)\s*.{0,2}(過件|核貸|下款|通過|撥款)/,
  /免(審核|審查|徵信)/,
  /無條件.{0,2}(核貸|放款|過件)/,
  /(秒|立即|當天).{0,2}(過件|核貸|撥款)/,
  /黑名單.{0,6}(也能|可過|可貸|OK)/i,
  /不(看|查).{0,2}(信用|聯徵|JCIC)/i,
  /(零|0)\s*(風險|費用|手續費)/,
];

const REGULATED_EXTRA: RegExp[] = [
  /\d+(\.\d+)?\s*%/,            // 利率／成數等數字須用企業審核資訊，不得由 LLM 生成
  /年利率|月利率|日利率/,
  /成功案例|客戶見證|已幫助\s*\d+/,
];

/** 回傳違規原因清單；空陣列代表通過。 */
export function checkContent(text: string, opts: { industry: string; bannedWords: string[] }): string[] {
  const issues: string[] = [];
  const t = text.trim();
  if (!t) issues.push('內容為空');
  if ([...t].length > THREADS_MAX_CHARS) issues.push(`超過 ${THREADS_MAX_CHARS} 字`);
  for (const re of ALWAYS_BANNED) if (re.test(t)) issues.push(`禁止宣稱：${re.source}`);
  if (REGULATED_INDUSTRIES.includes(opts.industry)) {
    for (const re of REGULATED_EXTRA) if (re.test(t)) issues.push(`受監管產業須人工填寫：${re.source}`);
  }
  for (const w of opts.bannedWords) if (w && t.includes(w)) issues.push(`企業禁用詞：${w}`);
  return issues;
}
