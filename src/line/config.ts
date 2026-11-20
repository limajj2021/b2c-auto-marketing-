export interface FormField {
  key: string;
  label: string;
  required: boolean;
  /** 若回答等於此值，立即中止流程並轉真人（例如未滿 18 歲） */
  blockIf?: string;
  options?: string[];
}

export interface LineConfig {
  welcome: string;
  menu: { info: string; inquiry: string; human: string };
  serviceInfo: string;
  businessHours: string;
  humanNotice: string;
  privacyNotice: string;
  completeMessage: string;
  fallback: string;
  services: string[];
  fields: FormField[];
}

export const DEFAULT_LINE_CONFIG: LineConfig = {
  welcome: '歡迎加入！請從下方選單選擇需要的服務。',
  menu: { info: '了解服務', inquiry: '立即詢問', human: '聯絡專人' },
  serviceInfo: '（請於後台填寫已核准的服務說明）',
  businessHours: '（請於後台填寫營業時間）',
  humanNotice: '已為您轉接專人，請稍候，我們的同仁將盡快親自回覆。自動回覆已暫停；輸入「選單」可回到自動服務。',
  privacyNotice:
    '【個資蒐集告知】我們將蒐集您提供的稱呼、需求與聯絡方式，僅用於回覆您的諮詢，保存期限內可隨時要求查詢或刪除。' +
    '請勿在此提供身分證號、銀行帳號密碼等敏感資料。若同意請輸入「同意」，不同意請輸入「取消」。',
  completeMessage: '已收到您的需求，我們會儘快與您聯繫，謝謝！',
  fallback: '抱歉，我不確定您的意思。請選擇下方選項，或聯絡專人。',
  services: ['一般諮詢'],
  fields: [
    { key: 'name', label: '請問怎麼稱呼您？', required: true },
    { key: 'need', label: '請簡述您的需求內容', required: true },
    { key: 'contact', label: '希望我們如何聯絡您？（例：LINE 訊息、電話＋方便時段）', required: true },
    { key: 'extra', label: '還有其他補充資訊嗎？', required: false },
  ],
};

export function parseLineConfig(raw: string): LineConfig {
  let o: any = {};
  try { o = JSON.parse(raw || '{}'); } catch { /* 使用預設 */ }
  const d = DEFAULT_LINE_CONFIG;
  return {
    ...d, ...o,
    menu: { ...d.menu, ...(o.menu ?? {}) },
    services: Array.isArray(o.services) && o.services.length ? o.services : d.services,
    fields: Array.isArray(o.fields) && o.fields.length ? o.fields : d.fields,
  };
}

/** 驗證後台提交的設定，回傳錯誤訊息或 null。 */
export function validateLineConfig(c: any): string | null {
  if (!c || typeof c !== 'object') return '格式錯誤';
  const strs = ['welcome', 'serviceInfo', 'businessHours', 'humanNotice', 'privacyNotice', 'completeMessage', 'fallback'];
  for (const k of strs) if (c[k] !== undefined && (typeof c[k] !== 'string' || c[k].length > 2000)) return `${k} 不合法`;
  if (c.menu) for (const k of ['info', 'inquiry', 'human']) {
    const v = c.menu[k];
    if (v !== undefined && (typeof v !== 'string' || !v.trim() || v.length > 20)) return `選單 ${k} 需為 1–20 字`;
  }
  if (c.services !== undefined && (!Array.isArray(c.services) || !c.services.length || c.services.length > 10 ||
      c.services.some((x: any) => typeof x !== 'string' || !x.trim() || x.length > 20))) return '服務類型需 1–10 項、每項 1–20 字';
  if (c.fields !== undefined) {
    if (!Array.isArray(c.fields) || !c.fields.length || c.fields.length > 12) return '表單欄位需 1–12 個';
    const keys = new Set<string>();
    for (const f of c.fields) {
      if (!f || !/^[a-z][a-z0-9_]{0,20}$/.test(f.key) || keys.has(f.key)) return '欄位 key 需為唯一的英文小寫';
      keys.add(f.key);
      if (typeof f.label !== 'string' || !f.label.trim()) return '欄位需有提問文字';
    }
  }
  return null;
}
