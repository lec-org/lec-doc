import { ForbiddenException } from '@nestjs/common';
import { UserService } from './user.service';

describe('Lec-managed Doc profile', () => {
  it('rejects identity fields but keeps Doc preferences editable', async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue({ id: 'user', name: 'Lec User', email: 'user@lec.test' }),
      hasLecIdentity: jest.fn().mockResolvedValue(true),
      updatePreference: jest.fn().mockResolvedValue(undefined),
    };
    const service = new UserService(repo as any, { log: jest.fn() } as any);
    const workspace = { id: 'workspace' } as any;

    await expect(service.update({ name: 'Doc Name' } as any, 'user', workspace))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update({ fullPageWidth: true } as any, 'user', workspace))
      .resolves.toBeUndefined();
    expect(repo.updatePreference).toHaveBeenCalledWith('user', 'fullPageWidth', true);
  });
});
