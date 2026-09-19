import { UnauthorizedException } from '@nestjs/common';
import { LecDesktopHandoffService } from '../lec-desktop-handoff.service';

class FakeRedis {
  values = new Map<string, string>();
  async set(key: string, value: string) {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }
  async getdel(key: string) {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

describe('Desktop subject-bound handoff', () => {
  it('consumes a 60-second origin/account-bound code exactly once', async () => {
    const redis = new FakeRedis();
    const service = new LecDesktopHandoffService(
      { getOrThrow: () => redis } as any,
      { encrypt: (value: string) => value, decrypt: (value: string) => value } as any,
    );
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const principal = {
      issuer: 'https://id.example.test/oidc',
      subject: 'desktop-user',
      email: 'desktop@example.test',
      name: 'Desktop User',
      realName: 'Desktop User',
      organizationId: '20000000-0000-4000-8000-000000000001',
      tenantRole: 'member' as const,
    };
    const issued = await service.issue(
      workspaceId,
      principal,
      'account-generation-7',
      'https://doc.example.test',
    );
    expect(issued).toMatchObject({ expiresInSeconds: 60 });
    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(
      service.consume(
        issued.code,
        workspaceId,
        'https://doc.example.test',
      ),
    ).resolves.toMatchObject({
      ...principal,
      accountGeneration: 'account-generation-7',
    });
    await expect(
      service.consume(
        issued.code,
        workspaceId,
        'https://doc.example.test',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('burns a code when the target origin does not match', async () => {
    const redis = new FakeRedis();
    const service = new LecDesktopHandoffService(
      { getOrThrow: () => redis } as any,
      { encrypt: (value: string) => value, decrypt: (value: string) => value } as any,
    );
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const issued = await service.issue(
      workspaceId,
      {
        issuer: 'https://id.example.test/oidc',
        subject: 'desktop-user',
        email: 'desktop@example.test',
        name: 'Desktop User',
      realName: 'Desktop User',
      organizationId: '20000000-0000-4000-8000-000000000001',
      tenantRole: 'member' as const,
      },
      '8',
      'https://doc.example.test',
    );
    await expect(
      service.consume(issued.code, workspaceId, 'https://evil.example.test'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
