import { QueueJob } from '../../integrations/queue/constants';
import { PageListener } from './page.listener';

describe('Page lifecycle listener', () => {
  it('uses a stable BullMQ-safe operation id for durable event retries', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const listener = new PageListener(queue as never);
    const operationId = '01995ad0-1111-7111-8111-111111111111';

    await listener.handlePageCreated({
      pageIds: ['01995ad0-2222-7222-8222-222222222222'],
      workspaceId: '01995ad0-3333-7333-8333-333333333333',
      operationId,
    });

    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.PAGE_CREATED,
      expect.any(Object),
      expect.objectContaining({ jobId: `${operationId}-created` }),
    );
  });
});
