import { ServiceUnavailableException } from '@nestjs/common';
import { AttachmentProcessor } from './attachment.processor';
import { AttachmentService } from '../services/attachment.service';
import { LecResourceLifecycleService } from '../../lec-authorization/lec-resource-lifecycle.service';
import { QueueJob } from '../../../integrations/queue/constants';

describe('AttachmentProcessor', () => {
  const attachmentService = { handleDeletePageAttachments: jest.fn() };
  const lifecycle = { requireDeletedTree: jest.fn() };
  const processor = new AttachmentProcessor(
    attachmentService as unknown as AttachmentService,
    lifecycle as unknown as LecResourceLifecycleService,
  );
  const job = {
    name: QueueJob.DELETE_PAGE_ATTACHMENTS,
    data: {
      pageId: 'child',
      rootPageId: 'root',
      workspaceId: 'workspace',
    },
  } as never;

  beforeEach(() => jest.resetAllMocks());

  it('checks Core immediately before deleting page objects', async () => {
    lifecycle.requireDeletedTree.mockResolvedValue(undefined);

    await processor.process(job);

    expect(lifecycle.requireDeletedTree).toHaveBeenCalledWith(
      'workspace',
      'root',
    );
    expect(
      lifecycle.requireDeletedTree.mock.invocationCallOrder[0],
    ).toBeLessThan(
      attachmentService.handleDeletePageAttachments.mock.invocationCallOrder[0],
    );
  });

  it('does not delete objects when Core is unavailable', async () => {
    lifecycle.requireDeletedTree.mockRejectedValue(
      new ServiceUnavailableException(),
    );

    await expect(processor.process(job)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(
      attachmentService.handleDeletePageAttachments,
    ).not.toHaveBeenCalled();
  });
});
