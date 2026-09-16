import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { ConfigService } from '@nestjs/config';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { LecBrowserSecurity } from '../lec-browser-security';
import { CollabWsAdapter } from '../../../collaboration/adapter/collab-ws.adapter';

describe('真实 Hocuspocus WS upgrade 的 Origin 边界', () => {
  let server: Server;
  let adapter: CollabWsAdapter;
  let address: string;
  let accepted: number;
  beforeEach(async () => {
    accepted = 0;
    server = createServer();
    adapter = new CollabWsAdapter(
      new LecBrowserSecurity(
        new EnvironmentService(
          new ConfigService({ APP_URL: 'https://doc.example.test' }),
        ),
      ),
    );
    adapter.handleUpgrade('/collab', server).on('connection', () => {
      accepted++;
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    address = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  });
  afterEach(async () => {
    adapter.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    undefined,
    'null',
    'https://evil.example.test',
    'https://doc.example.test/',
  ])('握手阶段拒绝 Origin %s，不创建协作连接', async (origin) => {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(address, {
        ...(origin ? { origin } : {}),
        headers: { cookie: 'authToken=must-not-be-trusted' },
      });
      ws.on('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      ws.on('open', () => {
        ws.close();
        resolve(101);
      });
      ws.on('error', reject);
    });
    expect(status).toBe(403);
    expect(accepted).toBe(0);
  });

  it('精确 Origin 可以建立连接', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(address, { origin: 'https://doc.example.test' });
      ws.on('open', () => {
        ws.close();
      });
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
    expect(accepted).toBe(1);
  });
});
