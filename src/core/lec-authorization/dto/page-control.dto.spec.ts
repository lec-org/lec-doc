import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ClassifyPageDto,
  RequestPageAccessDto,
  ReviewPageAccessDto,
} from './page-control.dto';

const control = {
  pageId: '10000000-0000-4000-8000-000000000001',
  operationId: '20000000-0000-4000-8000-000000000001',
  expectedVersion: 2,
};

async function errors<T extends object>(type: new () => T, value: object) {
  return validate(plainToInstance(type, value));
}

describe('page control DTO validation', () => {
  it('accepts an L1-L5 classification and rejects values outside the range', async () => {
    await expect(
      errors(ClassifyPageDto, { ...control, classification: 5 }),
    ).resolves.toHaveLength(0);
    await expect(
      errors(ClassifyPageDto, { ...control, classification: 6 }),
    ).resolves.not.toHaveLength(0);
  });

  it('trims access reasons and rejects blank or oversized reasons', async () => {
    const valid = plainToInstance(RequestPageAccessDto, {
      pageId: control.pageId,
      reason: '  Need access  ',
    });
    await expect(validate(valid)).resolves.toHaveLength(0);
    expect(valid.reason).toBe('Need access');
    await expect(
      errors(RequestPageAccessDto, { pageId: 'page-slug-id', reason: 'Need access' }),
    ).resolves.toHaveLength(0);
    await expect(
      errors(RequestPageAccessDto, { pageId: control.pageId, reason: '   ' }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors(RequestPageAccessDto, {
        pageId: control.pageId,
        reason: 'x'.repeat(1001),
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors(RequestPageAccessDto, {
        pageId: control.pageId,
        reason: '😀'.repeat(1000),
      }),
    ).resolves.toHaveLength(0);
  });

  it('requires a future expiry only when approving access', async () => {
    const request = {
      ...control,
      accessRequestId: '30000000-0000-4000-8000-000000000001',
    };
    await expect(
      errors(ReviewPageAccessDto, { ...request, decision: 'APPROVE' }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors(ReviewPageAccessDto, {
        ...request,
        decision: 'APPROVE',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors(ReviewPageAccessDto, { ...request, decision: 'REJECT' }),
    ).resolves.toHaveLength(0);
  });
});
