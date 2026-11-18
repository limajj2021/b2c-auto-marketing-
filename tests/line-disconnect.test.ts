// 中斷 LINE 官方帳號連接：刪除憑證、停止自動接待，其他品牌不受影響
import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { setCred } from '../src/integrations';
import { makeEnv } from './helpers';

const call = (env: any, method: string, path: string, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) },
  body: method === 'POST' && path === '/api/login' ? JSON.stringify({ username: 'boss', password: 'correct-horse-1' }) : undefined }));

describe('LINE disconnect', () => {
  it('removes the LINE credentials of this brand only', async () => {
    const env: any = await makeEnv();
    await setCred(env, 'b1', 'line_channel_access_token', 'tok', { basic_id: '@wrong' });
    await setCred(env, 'b1', 'line_channel_secret', 'sec');
    await env.DB.prepare(`INSERT INTO integrations(brand_id,name,value_enc,meta,updated_at) VALUES('b2','line_channel_access_token','x','{}','x')`).run();
    await env.DB.prepare(`UPDATE brand_settings SET line_auto_reply_enabled=1`).run();
    const c = ((await call(env, 'POST', '/api/login')).headers.get('set-cookie') ?? '').split(';')[0];
    expect((await call(env, 'DELETE', '/api/integrations/line', c)).status).toBe(200);
    const rows: any[] = (await env.DB.prepare(`SELECT brand_id,name FROM integrations`).all()).results;
    expect(rows).toEqual([{ brand_id: 'b2', name: 'line_channel_access_token' }]);
    expect(((await env.DB.prepare(`SELECT line_auto_reply_enabled v FROM brand_settings WHERE brand_id='b1'`).first()) as any).v).toBe(0);
    expect(((await env.DB.prepare(`SELECT detail FROM audit_logs WHERE action='line_disconnect'`).first()) as any).detail).toBe('@wrong');
  });
});
