/* 品牌資料包：產生給客戶自己的 AI 用的指令，並解析 AI 整理好的結果。
 * 獨立成檔是為了能做自動化測試；瀏覽器載入後掛在 window.BrandKit。
 * 設計原則：解析要「寬鬆」（AI 常加粗、用全形括號、多講幾句話），但寫入要「保守」（待確認的資料不採用、不確定就略過）。 */
(function (root) {
  'use strict';

  // key：內部名稱；api：儲存時送給 PUT /settings 的欄位；aliases：AI 可能寫出的標題別名
  var FIELDS = [
    { key: 'name', label: '品牌名稱', api: 'name', type: 'text', max: 100, aliases: ['品牌名稱', '品牌名', '名稱'] },
    { key: 'description', label: '品牌介紹', api: 'description', type: 'text', max: 1000, aliases: ['品牌介紹', '品牌簡介', '簡介', '介紹'] },
    { key: 'services', label: '產品與服務', api: 'services', type: 'text', max: 2000, aliases: ['產品與服務', '產品服務', '服務內容', '產品', '服務'] },
    { key: 'audience', label: '目標受眾', api: 'audience', type: 'text', max: 2000, aliases: ['目標受眾', '受眾', '客群', '目標客群', '目標客戶'] },
    { key: 'tone', label: '品牌語氣', api: 'content_tone', type: 'text', max: 2000, aliases: ['品牌語氣', '語氣', '口吻', '品牌調性', '調性'] },
    { key: 'topics', label: '內容主題', api: 'content_topics', type: 'list', aliases: ['內容主題', '主題', '內容方向'] },
    { key: 'banned', label: '禁用詞', api: 'banned_words', type: 'list', aliases: ['禁用詞', '禁語', '不能說', '避免用語', '禁用字詞'] },
    { key: 'style', label: '寫作原則', api: 'style_preset', type: 'text', max: 500, aliases: ['寫作原則', '寫作風格', '文案原則'] },
    { key: 'facts', label: '可引用數據', api: 'fact_bank', type: 'facts', max: 5000, aliases: ['可引用數據', '可引用的數據', '數據', '事實'] },
    { key: 'cta', label: 'CTA 文字', api: 'cta_text', type: 'text', max: 500, aliases: ['CTA 文字', 'CTA文字', 'CTA', '行動呼籲', '結尾引導'] },
  ];

  var FORMAT = [
    '=== 品牌資料包 ===',
    '[品牌名稱]', '（一行）',
    '[品牌介紹]', '（2～4 句，只寫可以公開的資訊，300 字內）',
    '[產品與服務]', '（每項一行：名稱＋一句話說明）',
    '[目標受眾]', '（誰會買、他們的困擾與使用情境）',
    '[品牌語氣]', '（例如：專業但不說教、口語、有點幽默；一行）',
    '[內容主題]', '（5～10 個，每行一個）',
    '[禁用詞]', '（不能出現的字眼或說法，每行一個；沒有就寫「無」）',
    '[寫作原則]', '（一行，例如：爭議化、數據化、具體化）',
    '[可引用數據]', '（每行一筆「數字＋出處」；沒有可驗證的就寫「無」，不確定的標「待確認」）',
    '[CTA 文字]', '（貼文最後引導加 LINE 的一句話）',
    '=== 結束 ===',
  ].join('\n');

  var norm = function (s) { return String(s).replace(/\s+/g, '').toLowerCase(); };
  var ALIAS = {};
  FIELDS.forEach(function (f) { f.aliases.forEach(function (a) { ALIAS[norm(a)] = f; }); });

  // 代表「沒有內容」的寫法
  var EMPTY = /^(無|沒有|n\/a|na|none|null|未提供|不適用|尚未提供|待確認|待補|待補充|—|-)[。.!！]?$/i;
  // 範本裡的提示文字，AI 沒改就原樣貼回來時要忽略
  var PLACEHOLDER = /^[（(][^）)]*(一行|每行|例如|只寫|2～|5～|沒有就寫|字內)[^）)]*[）)]$/;
  var UNSURE = /待確認|待補|請補|請提供|XX|○○|\?\?/;

  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/\r/g, '')
      .replace(/```[a-zA-Z]*\n?/g, '')
      .replace(/[【［]/g, '[').replace(/[】］]/g, ']')
      .replace(/\*\*|__/g, '');
  }

  var HEAD = /^\s*(?:#{1,6}\s*)?(?:[-*•]\s*)?\[\s*([^\]\n]{1,16}?)\s*\]\s*[:：]?\s*(.*)$/;

  function stripBullet(l) { return l.replace(/^\s*(?:[-*•·]|\d+[.)、）])\s*/, '').trim(); }
  function unquote(l) { return l.replace(/^["'「『“”]+|["'」』“”]+$/g, '').trim(); }
  // 範本裡的提示行（以全形括號開頭的整行）：AI 沒改就原樣貼回來時視為沒填
  var TEMPLATE_HINTS = {};
  FORMAT.split('\n').forEach(function (l) { if (/^[（(]/.test(l)) TEMPLATE_HINTS[l.trim()] = 1; });
  function isPlaceholder(v) { v = String(v).trim(); return !!TEMPLATE_HINTS[v] || PLACEHOLDER.test(v); }
  function isEmptyValue(v) { return !v || EMPTY.test(v.trim()) || isPlaceholder(v); }

  function parseList(v) {
    var seen = {}, out = [];
    // 先整行判斷是不是範本提示，再用逗號、頓號等拆開（否則提示文字會被拆碎而認不出來）
    // 一行一項時只按行拆（項目本身可能含「、」，例如「手動、半自動與全自動發文」）；只有一行時才用標點拆
    var lines = String(v).split('\n').filter(function (l) { return l.trim() && !isPlaceholder(l); });
    (lines.length > 1 ? lines : lines.join('').split(/[,，、;；]+/)).forEach(function (raw) {
      var x = unquote(stripBullet(raw));
      if (!x || EMPTY.test(x) || isPlaceholder(x) || UNSURE.test(x)) return;
      x = x.slice(0, 100);
      var k = x.toLowerCase();
      if (!seen[k]) { seen[k] = 1; out.push(x); }
    });
    return out.slice(0, 50);
  }

  function parseFacts(v) {
    var out = [], dropped = 0;
    String(v).split('\n').forEach(function (raw) {
      var x = stripBullet(raw);
      if (!x || EMPTY.test(x) || isPlaceholder(x)) return;
      if (UNSURE.test(x)) { dropped++; return; } // 沒有出處或待確認的數字，不放進可引用數據
      out.push(x);
    });
    return { text: out.join('\n'), dropped: dropped };
  }

  function hasHeading(block) {
    return normalize(block).split('\n').some(function (l) { var m = l.match(HEAD); return !!(m && ALIAS[norm(m[1])]); });
  }

  /** 解析 AI 輸出。回傳 { fields, found, skipped, truncated }；fields 只含有內容的欄位 */
  function parse(text) {
    var src = String(text == null ? '' : text), blocks = src.match(/```[a-zA-Z]*\n[\s\S]*?```/g) || [];
    // AI 常在程式碼區塊外多講幾句話：有含標題的區塊就只讀區塊內
    for (var b = 0; b < blocks.length; b++) { if (hasHeading(blocks[b])) { src = blocks[b]; break; } }
    var lines = normalize(src).split('\n'), cur = null, buf = {};
    lines.forEach(function (line) {
      if (/^\s*=+\s*(結束|end)\s*=+\s*$/i.test(line)) { cur = null; return; } // 結束標記之後不再讀
      if (/^\s*=+.*=+\s*$/.test(line)) return; // === 品牌資料包 === 之類的分隔線
      var m = line.match(HEAD), f = m && ALIAS[norm(m[1])];
      if (f) { cur = f.key; buf[cur] = buf[cur] || []; if (m[2] && m[2].trim()) buf[cur].push(m[2]); return; }
      if (cur) buf[cur].push(line);
    });
    var fields = {}, found = [], skipped = [], truncated = [];
    FIELDS.forEach(function (f) {
      if (!(f.key in buf)) return;
      var raw = buf[f.key].join('\n').trim();
      if (f.type === 'list') {
        var l = parseList(raw);
        if (!l.length) { skipped.push({ key: f.key, label: f.label, reason: isEmptyValue(raw) || !raw ? '沒有內容' : '都是待確認' }); return; }
        fields[f.key] = l; found.push(f.key);
      } else if (f.type === 'facts') {
        var r = parseFacts(raw);
        if (!r.text) { skipped.push({ key: f.key, label: f.label, reason: r.dropped ? '全部是待確認，未採用' : '沒有內容' }); return; }
        if (r.dropped) skipped.push({ key: f.key, label: f.label, reason: r.dropped + ' 筆待確認的數據未採用' });
        if (r.text.length > f.max) { r.text = r.text.slice(0, f.max); truncated.push(f.label); }
        fields[f.key] = r.text; found.push(f.key);
      } else {
        var v = unquote(raw.split('\n').map(function (x) { return x.trim(); }).filter(Boolean).join('\n'));
        if (isEmptyValue(v)) { skipped.push({ key: f.key, label: f.label, reason: '沒有內容' }); return; }
        if (v.length > f.max) { v = v.slice(0, f.max); truncated.push(f.label); }
        fields[f.key] = v; found.push(f.key);
      }
    });
    return { fields: fields, found: found, skipped: skipped, truncated: truncated };
  }

  function union(a, b) {
    var seen = {}, out = [];
    a.concat(b).forEach(function (x) { var k = String(x).toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(x); } });
    return out;
  }

  /** 與目前資料比對。文字欄位取代；內容主題、禁用詞、可引用數據「合併」，不會把客戶原有的刪掉。 */
  function plan(current, parsed) {
    return FIELDS.filter(function (f) { return f.key in parsed.fields; }).map(function (f) {
      var old = current[f.key], nw = parsed.fields[f.key], fin, mode = '取代';
      if (f.type === 'list') { old = old || []; fin = union(old, nw); mode = '合併'; }
      else if (f.type === 'facts') {
        old = old || ''; var have = {}; old.split('\n').forEach(function (l) { have[l.trim()] = 1; });
        fin = (old ? old.split('\n').filter(Boolean) : []).concat(nw.split('\n').filter(function (l) { return !have[l.trim()]; })).join('\n'); mode = '合併';
      } else { old = old || ''; fin = nw; }
      var changed = JSON.stringify(fin) !== JSON.stringify(old);
      return { key: f.key, label: f.label, api: f.api, type: f.type, mode: mode, old: old, final: fin, changed: changed,
        kind: !(f.type === 'list' ? old.length : old) ? '新增' : changed ? (mode === '合併' ? '補充' : '更新') : '沒有變化' };
    });
  }

  /** 選取的項目 → PUT /settings 的內容 */
  function toPayload(items) {
    var p = {};
    items.forEach(function (i) { p[i.api] = i.final; });
    return p;
  }

  function currentText(c) {
    var j = function (v) { return Array.isArray(v) ? v.join('、') : (v || ''); };
    var rows = FIELDS.map(function (f) { var v = j(c[f.key]); return '[' + f.label + '] ' + (v ? String(v).replace(/\n+/g, ' / ').slice(0, 300) : '（尚未填寫）'); });
    return rows.join('\n');
  }

  /** 三段依序貼給客戶自己的 AI 的指令 */
  function prompts(ctx) {
    ctx = ctx || {};
    var cur = currentText(ctx.current || {});
    var reg = ctx.regulated ? '\n- 我的行業屬於放款／金融：請不要寫任何利率、核准率、保證、一定會過這類字眼，也不要放案例數字。' : '';
    // 一段指令完成：盤點 → 訪談 → 輸出。客戶只要複製一次、貼一次。
    return [{
      id: 'all', title: '複製這段指令，貼到你的 AI',
      purpose: 'AI 會先看它已經知道你什麼，再一次問一題把缺的補齊，最後整理成品牌資料包。數字沒出處會標「待確認」，不會亂編。',
      text: '你現在是我的品牌顧問。我要整理一份品牌資料，交給 AI 自動撰寫 Threads 貼文。請照下面三個階段進行，一個階段做完再進下一個。\n\n' +
        '【階段一：盤點】\n' +
        '先回顧我們過去的所有對話（如果你有記憶或對話紀錄），加上下方「系統目前的資料」，用簡短條列告訴我這 10 項你已經知道什麼、還缺什麼：\n' +
        '1. 品牌名稱  2. 品牌介紹  3. 產品與服務  4. 目標受眾  5. 品牌語氣  6. 內容主題  7. 禁用詞（不能說的話）  8. 寫作原則  9. 可引用的數據（含出處）  10. 貼文結尾的 CTA\n' +
        '沒有紀錄就直接說沒有，不要猜測、不要編造。\n\n' +
        '【階段二：訪談】\n' +
        '針對還缺或不確定的項目，一次只問我一個問題：\n' +
        '- 每題附 2～3 個範例答案，我可以直接選或改寫。\n' +
        '- 我回答後才問下一題，不要一次丟出多個問題。\n' +
        '- 問到數字、成效、客戶見證時，請我提供出處；我沒有就標「待確認」，不要幫我編造任何數字。\n' +
        '- 全部問完後，用 3 句話總結你理解的我的品牌，問我有沒有偏差。' + reg + '\n\n' +
        '【階段三：輸出】\n' +
        '我確認沒問題後，輸出「品牌資料包」：\n' +
        '- 嚴格照下面格式，標題的 [方括號] 不要改，整份放在「一個程式碼區塊」裡，區塊外不要加任何說明。\n' +
        '- 只寫我明確說過、或對話中確實出現過的事實；不確定的寫「待確認」；絕對不要編造數字、案例、客戶名稱。\n' +
        '- 不要放任何個人資料、密碼、帳號、身分證或私人聯絡方式。\n' +
        '- 沒有內容的項目寫「無」。\n\n' +
        '格式：\n' + FORMAT + '\n\n' +
        '系統目前的資料（可能不完整或過時，僅供參考）：\n' + cur + '\n\n' +
        '現在請從【階段一】開始。',
    }];
  }

  var api = { FIELDS: FIELDS, FORMAT: FORMAT, parse: parse, plan: plan, toPayload: toPayload, prompts: prompts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BrandKit = api;
})(typeof window !== 'undefined' ? window : this);
