import { ForbiddenException } from '@nestjs/common';
import { AttachmentController } from './attachment.controller';

function controller(overrides: Record<string, any> = {}) {
  const storage = {
    readStream: jest.fn(),
    readRangeStream: jest.fn(),
  };
  const page = {
    id: 'page',
    workspaceId: 'workspace',
    spaceId: 'space',
    deletedAt: null,
  };
  const attachment = {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: 'workspace',
    pageId: page.id,
    spaceId: page.spaceId,
    fileName: 'secret.pdf',
    fileExt: '.pdf',
    filePath: 'secret/path',
    fileSize: 100,
    mimeType: 'application/pdf',
  };
  const lec = {
    page: jest.fn().mockResolvedValue([{ allowed: false }]),
    deny: jest.fn(() => {
      throw new ForbiddenException();
    }),
  };
  const instance = new AttachmentController(
    {} as any,
    storage as any,
    {} as any,
    {} as any,
    { findById: jest.fn().mockResolvedValue(page) } as any,
    { findById: jest.fn().mockResolvedValue(attachment) } as any,
    {} as any,
    {
      verifyJwt: jest.fn().mockResolvedValue({
        attachmentId: attachment.id,
        pageId: page.id,
        workspaceId: page.workspaceId,
      }),
    } as any,
    {} as any,
    {} as any,
    lec as any,
    { log: jest.fn() } as any,
  );
  return { instance, storage, lec, attachment, ...overrides };
}

describe('AttachmentController public downloads', () => {
  it.each([undefined, 'bytes=0-9'])(
    'rechecks anonymous Core VIEW before %s storage reads',
    async (range) => {
      const { instance, storage, attachment } = controller();
      const req = { headers: { range } } as any;
      const res = {} as any;

      await expect(
        instance.getPublicFile(
          req,
          res,
          { id: 'workspace' } as any,
          attachment.id,
          attachment.fileName,
          'signed-token',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(storage.readStream).not.toHaveBeenCalled();
      expect(storage.readRangeStream).not.toHaveBeenCalled();
    },
  );
});
