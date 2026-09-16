import { AddressInfo } from 'node:net';
import { Server, ServerOptions } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { WsRedisIoAdapter } from '../../../ws/adapter/ws-redis.adapter';
import { LecBrowserSecurity } from '../lec-browser-security';

describe('真实 Socket.IO polling 握手的 Origin 边界', () => {
  let io: Server;
  let address: string;
  beforeEach(async () => {
    const adapter = new WsRedisIoAdapter(
      undefined,
      new LecBrowserSecurity(
        new EnvironmentService(
          new ConfigService({ APP_URL: 'https://doc.example.test' }),
        ),
      ),
    );
    // 此处只验真实握手；Redis 广播替换为 Socket.IO 自带内存 adapter。
    Object.assign(adapter, { adapterConstructor: new Server().adapter() });
    io = adapter.createIOServer(0, { serveClient: false } as ServerOptions);
    const server = io.httpServer;
    if (!server.listening)
      await new Promise<void>((resolve) => server.once('listening', resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/socket.io/?EIO=4&transport=polling`;
  });
  afterEach(async () => {
    if (io) await new Promise<void>((resolve) => io.close(() => resolve()));
  });
  it.each([
    undefined,
    'null',
    'https://evil.example.test',
    'https://doc.example.test/',
  ])('拒绝 Origin %s', async (origin) => {
    const response = await fetch(address, {
      headers: {
        ...(origin ? { origin } : {}),
        cookie: 'authToken=not-trusted',
      },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('sid');
  });
  it('精确 Origin 才能获得 Engine.IO 握手', async () => {
    const response = await fetch(address, {
      headers: { origin: 'https://doc.example.test' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/^0\{"sid"/);
  });
});
