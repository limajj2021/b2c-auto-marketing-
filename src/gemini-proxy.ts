// Gemini 轉送：Google 不接受部分地區（例如香港）發出的 Gemini 請求，會回「User location is not supported」。
// 主系統跑在離使用者最近的 Cloudflare 機房，台灣的連線有時會被分到香港；這個小程式固定在美國執行，
// 主系統透過內部綁定（service binding）呼叫它，由它代為連到 Gemini。沒有公開網址，只轉送到 Gemini 的網址。
const ALLOWED_HOST = 'generativelanguage.googleapis.com';

export default {
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    // 檢查用：回傳這個程式實際連外的機房與國家
    if (u.pathname === '/__where') return fetch('https://www.cloudflare.com/cdn-cgi/trace');
    if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOST) return new Response('forbidden', { status: 403 });
    return fetch(new Request(req));
  },
} satisfies ExportedHandler;
