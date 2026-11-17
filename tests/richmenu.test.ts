// LINE 圖文選單：後台畫好的圖 → 建立選單、上傳圖片、設為預設；失敗時不留垃圾
import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { bounds, normalize } from '../src/line/richmenu';
import { setCred } from '../src/integrations';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const call = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const ck = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const IMG = 'data:image/jpeg;base64,' + btoa('fake-jpeg-bytes');
const menu = (over: any = {}) => ({ layout: 'l3', chatBarText: '選單', image: IMG,
  areas: [{ label: '官網', type: 'url', value: 'https://example.com' }, { label: '了解服務', type: 'text', value: '了解服務' }, { label: '預約', type: 'text', value: '預約' }], ...over });

async function setup() {
  const env: any = await makeEnv();
  await setCred(env, 'b1', 'line_channel_access_token', 'T'.repeat(60));
  const c = ck(await call(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' }));
  return { env, c };
}

describe('LINE rich menu', () => {
  it('splits the canvas into whole-pixel cells that cover it exactly', () => {
    const b = bounds('l6');
    expect(b).toHaveLength(6);
    expect(b[2].x + b[2].width).toBe(2500); expect(b[5].y + b[5].height).toBe(1686);
    expect(bounds('l3').map((x) => x.width)).toEqual([833, 833, 834]);
  });

  it('validates buttons with messages a customer can act on', () => {
    expect(() => normalize(menu({ layout: 'zz' }))).toThrow('版型');
    expect(() => normalize(menu({ layout: 'l6' }))).toThrow('6 個按鈕');
    expect(() => normalize(menu({ areas: [{ label: '官網', type: 'url', value: 'javascript:alert(1)' }, ...menu().areas.slice(1)] }))).toThrow('https://');
    expect(() => normalize(menu({ chatBarText: '一二三四五六七八九十一二三四五' }))).toThrow('14');
  });

  it('creates the menu, uploads the image, sets it as default, and replaces the previous one', async () => {
    const { env, c } = await setup();
    let n = 0;
    const m = mockFetch((u, init) => {
      if (u.endsWith('/v2/bot/richmenu') && init?.method === 'POST') return jres({ richMenuId: `rm-${++n}` });
      if (u.includes('/v2/bot/user/all/richmenu') && !init?.method) return jres({ richMenuId: `rm-${n}` });
      return jres({});
    }); restore = m.restore;
    const r = await call(env, 'POST', '/api/line/richmenu', menu(), c);
    expect(r.status).toBe(200);
    const created = JSON.parse(String(m.calls.find((x) => x.url.endsWith('/v2/bot/richmenu'))!.init!.body));
    expect(created.size).toEqual({ width: 2500, height: 843 });
    expect(created.areas[0].action).toEqual({ type: 'uri', label: '官網', uri: 'https://example.com' });
    expect(created.areas[1].action).toEqual({ type: 'message', label: '了解服務', text: '了解服務' });
    expect(m.calls.some((x) => x.url === 'https://api-data.line.me/v2/bot/richmenu/rm-1/content' && (x.init!.headers as any)['content-type'] === 'image/jpeg')).toBe(true);
    expect(m.calls.some((x) => x.url.endsWith('/v2/bot/user/all/richmenu/rm-1') && x.init!.method === 'POST')).toBe(true);
    const st = (await (await call(env, 'GET', '/api/line/richmenu', undefined, c)).json()) as any;
    expect(st.active).toBe(true); expect(st.config.areas).toHaveLength(3);
    // 再發布一次：舊的選單被刪掉
    await call(env, 'POST', '/api/line/richmenu', menu(), c);
    expect(m.calls.some((x) => x.url.endsWith('/v2/bot/richmenu/rm-1') && x.init!.method === 'DELETE')).toBe(true);
  });

  it('deletes the half-made menu when the image upload fails, and explains why', async () => {
    const { env, c } = await setup();
    const m = mockFetch((u, init) => u.endsWith('/v2/bot/richmenu') ? jres({ richMenuId: 'rm-x' })
      : u.includes('api-data') ? jres({ message: 'Image size must be 2500x843' }, 400) : jres({})); restore = m.restore;
    const r = await call(env, 'POST', '/api/line/richmenu', menu(), c);
    expect(r.status).toBe(400); expect(((await r.json()) as any).error).toContain('上傳選單圖片失敗');
    expect(m.calls.some((x) => x.url.endsWith('/v2/bot/richmenu/rm-x') && x.init!.method === 'DELETE')).toBe(true);
  });

  it('removes the menu but keeps the design for next time; needs LINE connected; staff cannot publish', async () => {
    const { env, c } = await setup();
    const m = mockFetch((u, init) => u.endsWith('/v2/bot/richmenu') && init?.method === 'POST' ? jres({ richMenuId: 'rm-1' }) : jres({})); restore = m.restore;
    await call(env, 'POST', '/api/line/richmenu', menu(), c);
    expect((await call(env, 'DELETE', '/api/line/richmenu', undefined, c)).status).toBe(200);
    expect(m.calls.some((x) => x.url.endsWith('/v2/bot/user/all/richmenu') && x.init!.method === 'DELETE')).toBe(true);
    const st = (await (await call(env, 'GET', '/api/line/richmenu', undefined, c)).json()) as any;
    expect(st.config.id).toBeUndefined(); expect(st.config.areas[0].label).toBe('官網');
    const fresh: any = await makeEnv(); fresh.LINE_CHANNEL_ACCESS_TOKEN = '';
    const c2 = ck(await call(fresh, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' }));
    expect((await call(fresh, 'POST', '/api/line/richmenu', menu(), c2)).status).toBe(409);
    const staff = ck(await call(env, 'POST', '/api/login', { username: 'cs', password: 'staff-password-1' }));
    expect((await call(env, 'POST', '/api/line/richmenu', menu(), staff)).status).toBe(403);
  });
});
