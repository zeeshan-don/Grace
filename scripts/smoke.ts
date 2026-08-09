/** Temporary smoke test for the M12 API server — removed after validation. */
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../src/api/server.ts';

async function main(): Promise<void> {
  const server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const show = async (label: string, res: Response): Promise<void> => {
    const text = await res.text().catch(() => '');
    console.log(`\n--- ${label} ---`);
    console.log(
      `status=${res.status} cors=${res.headers.get('access-control-allow-origin') ?? '-'} allow=${res.headers.get('allow') ?? '-'} retry-after=${res.headers.get('retry-after') ?? '-'}`,
    );
    console.log(text.slice(0, 250));
  };

  await show('GET /api/health', await fetch(base + '/api/health'));
  await show('OPTIONS /api/usage (preflight)', await fetch(base + '/api/usage', { method: 'OPTIONS' }));
  await show(
    'POST /api/auth/login without DB (expect 503)',
    await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', password: 'password123' }),
    }),
  );
  await show('GET /api/nope (404 + CORS)', await fetch(base + '/api/nope'));
  await show('POST /api/health (405 + Allow)', await fetch(base + '/api/health', { method: 'POST' }));
  await show(
    'POST /api/usage without token (expect 401)',
    await fetch(base + '/api/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  );

  server.close();
  console.log('\nSMOKE OK');
}

void main();
