import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetch } from 'undici';
import { z } from 'zod';
import { OutboundAgentFactory } from '../../integrations/outbound/outbound-agent.factory';
import { loadInternalCa } from '../../integrations/outbound/internal-ca';

const commandSchema = z.strictObject({
  event_id: z.uuid(),
  workspace_id: z.uuid(),
  resource_id: z.uuid(),
  recipient: z.strictObject({
    issuer: z.url(),
    subject: z.string().min(1).max(255),
  }),
  event_type: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  text: z.string().min(1).max(4000),
});

export type LecImNotificationCommand = z.infer<typeof commandSchema>;

const responseSchema = z.strictObject({
  data: z.strictObject({
    event_id: z.uuid(),
    status: z.literal('ACCEPTED'),
  }),
});

@Injectable()
export class LecImNotificationClient {
  private readonly caCert: string;

  constructor(
    private readonly config: ConfigService,
    private readonly agents: OutboundAgentFactory,
  ) {
    this.caCert = loadInternalCa(
      this.config.getOrThrow<string>('LEC_INTERNAL_CA_FILE'),
    );
  }

  configured(): boolean {
    return Boolean(this.config.get<string>('LEC_IM_NOTIFICATION_URL'));
  }

  async send(input: LecImNotificationCommand): Promise<void> {
    const command = commandSchema.parse(input);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    try {
      const rawUrl = this.config.getOrThrow<string>('LEC_IM_NOTIFICATION_URL');
      const url = new URL(rawUrl);
      if (
        url.pathname !== '/internal/v1/document-notifications' ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw new Error('LecIM notification URL invalid');
      const token = this.config.getOrThrow<string>(
        'LEC_DOC_NOTIFICATION_TOKEN',
      );
      if (!/^[\x21-\x7e]{32,4096}$/.test(token))
        throw new Error('LecIM notification credential invalid');
      const body = JSON.stringify(command);
      if (Buffer.byteLength(body) > 1024 * 1024)
        throw new Error('LecIM notification request too large');
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error('LecIM notification deadline exceeded'));
        }, 3000);
      });
      await Promise.race([
        (async () => {
          const lease = await this.agents.lease(url.toString(), {
            caCert: this.caCert,
          });
          try {
            abort.signal.throwIfAborted();
            const response = await fetch(url, {
              method: 'POST',
              redirect: 'error',
              signal: abort.signal,
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
              },
              body,
              dispatcher: lease.dispatcher,
            });
            const contentType = response.headers
              .get('content-type')
              ?.toLowerCase();
            if (
              response.status !== 200 ||
              !contentType?.startsWith('application/json')
            ) {
              await response.body?.cancel();
              throw new Error('LecIM notification response unavailable');
            }
            const chunks: Uint8Array[] = [];
            let size = 0;
            for await (const chunk of response.body) {
              size += chunk.byteLength;
              if (size > 1024 * 1024)
                throw new Error('LecIM notification response too large');
              chunks.push(chunk);
            }
            const parsed = responseSchema.parse(
              JSON.parse(Buffer.concat(chunks).toString('utf8')),
            );
            if (parsed.data.event_id !== command.event_id)
              throw new Error('LecIM notification response mismatch');
          } finally {
            await lease.release();
          }
        })(),
        deadline,
      ]);
    } catch {
      throw new ServiceUnavailableException({
        code: 'LEC_IM_NOTIFICATION_UNAVAILABLE',
        message: '云文档消息通知暂不可用',
      });
    } finally {
      clearTimeout(timer!);
    }
  }
}
