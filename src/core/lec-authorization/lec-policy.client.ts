import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { fetch } from 'undici';
import { z } from 'zod';
import { OutboundAgentFactory } from '../../integrations/outbound/outbound-agent.factory';
import { loadInternalCa } from '../../integrations/outbound/internal-ca';
import {
  batchResponseSchema,
  LecDecision,
  LecPolicyItem,
  LecPrincipal,
  policyItemSchema,
  principalSchema,
} from './lec-policy.types';

// 路径由服务端用例选择；不接受 URL，也不把 service credential 用作用户授权。
export type LecCorePath =
  | 'doc-authorize-batch'
  | 'doc-spaces/bind'
  | 'doc-resources/reserve'
  | 'doc-resources/activate'
  | 'doc-resources/cancel'
  | 'doc-trees/delete'
  | 'doc-trees/restore'
  | 'doc-trees/reactivate'
  | 'doc-trees/cancel-restore'
  | 'doc-control/classify'
  | 'doc-control/transfer-owner'
  | 'doc-control/grant'
  | 'doc-control/revoke-grant'
  | 'doc-control/request-access'
  | 'doc-control/review-access'
  | 'doc-control/revoke-access'
  | 'doc-control/save-group'
  | 'doc-control/reparent';

@Injectable()
export class LecPolicyClient {
  private readonly caCert: string;

  constructor(
    private readonly config: ConfigService,
    private readonly agents: OutboundAgentFactory,
  ) {
    this.caCert = loadInternalCa(
      this.config.getOrThrow<string>('LEC_INTERNAL_CA_FILE'),
    );
  }

  /** 每次调用重新联网；唯一去重范围是本次 batch，不缓存正授权。 */
  async authorize(
    workspaceId: string,
    principal: LecPrincipal,
    items: LecPolicyItem[],
  ): Promise<LecDecision[]> {
    try {
      z.uuid().parse(workspaceId);
      principalSchema.parse(principal);
      const input = z.array(policyItemSchema).min(1).max(100).parse(items);
      const key = (i: LecPolicyItem) =>
        `${i.resource_kind}:${i.resource_id}:${i.capability}`;
      const unique = [
        ...new Map(input.map((item) => [key(item), item])).values(),
      ];
      const requested = unique.map((item, i) => ({
        ...item,
        item_id: String(i),
      }));
      const requestId = randomUUID();
      const response = await this.send(
        'doc-authorize-batch',
        {
          request_id: requestId,
          workspace_id: workspaceId,
          principal,
          items: requested,
        },
        batchResponseSchema,
      );
      if (
        response.data.request_id !== requestId ||
        response.data.items.length !== requested.length
      )
        throw new Error('PDP batch mismatch');
      const decisions = new Map<string, LecDecision>();
      const seen = new Set<string>();
      for (const decision of response.data.items) {
        const original = requested.find(
          (item) => item.item_id === decision.item_id,
        );
        if (
          !original ||
          seen.has(decision.item_id) ||
          decision.workspace_id !== workspaceId ||
          key(original) !== key(decision)
        )
          throw new Error('PDP item mismatch');
        seen.add(decision.item_id);
        decisions.set(key(decision), decision);
      }
      return input.map((item) => decisions.get(key(item))!);
    } catch {
      throw this.unavailable();
    }
  }

  /** 一个总截止时间覆盖 DNS、连接、响应体与校验；错误中不包含凭据或上游响应。 */
  async send<T>(
    path: LecCorePath,
    payload: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    try {
      const origin = new URL(this.config.getOrThrow<string>('LEC_CORE_URL'));
      if (
        origin.protocol !== 'https:' ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password
      )
        throw new Error('Core origin invalid');
      if (
        !/^doc-(authorize-batch|spaces\/bind|resources\/(reserve|activate|cancel)|trees\/(delete|restore|reactivate|cancel-restore)|control\/(classify|transfer-owner|grant|revoke-grant|request-access|review-access|revoke-access|save-group|reparent))$/.test(
          path,
        )
      )
        throw new Error('Core path invalid');
      const token = this.config.getOrThrow<string>('LEC_DOC_INTERNAL_TOKEN');
      if (!/^[\x21-\x7e]{32,4096}$/.test(token))
        throw new Error('Core credential invalid');
      const body = JSON.stringify(payload);
      if (!body || Buffer.byteLength(body) > 1024 * 1024)
        throw new Error('Core request too large');
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(this.unavailable());
        }, 3000);
      });
      const request = (async () => {
        const url = `${origin.origin}/api/v1/internal/${path}`;
        const lease = await this.agents.lease(url, { caCert: this.caCert });
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
          if (!contentType?.startsWith('application/json')) {
            await response.body?.cancel();
            throw new Error('Core response unavailable');
          }
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > 2 * 1024 * 1024)
              throw new Error('Core response too large');
            chunks.push(chunk);
          }
          const json: unknown = JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          );
          if (response.status !== 200) {
            throw this.commandError(path, response.status, json);
          }
          return schema.parse(json);
        } finally {
          await lease.release();
        }
      })();
      return await Promise.race([request, deadline]);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw this.unavailable();
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }

  private commandError(
    path: LecCorePath,
    status: number,
    body: unknown,
  ): HttpException {
    // PDP 查询始终由 authorize() 折叠为 fail-closed 503；只有命令保留稳定、可行动的错误语义。
    if (path === 'doc-authorize-batch') return this.unavailable();
    const parsed = z
      .strictObject({
        error: z.strictObject({
          code: z.enum([
            'DOC_INVALID_REQUEST',
            'DOC_FORBIDDEN',
            'DOC_VERSION_CONFLICT',
          ]),
          message: z.string().min(1).max(256),
        }),
      })
      .safeParse(body);
    if (!parsed.success) return this.unavailable();
    const safe = {
      code: parsed.data.error.code,
      message:
        parsed.data.error.code === 'DOC_INVALID_REQUEST'
          ? '文档请求格式无效'
          : parsed.data.error.code === 'DOC_FORBIDDEN'
            ? '没有文档操作权限'
            : '文档状态已变化，请刷新重试',
    };
    if (status === 400 && safe.code === 'DOC_INVALID_REQUEST')
      return new BadRequestException(safe);
    if (status === 403 && safe.code === 'DOC_FORBIDDEN')
      return new ForbiddenException(safe);
    if (status === 409 && safe.code === 'DOC_VERSION_CONFLICT')
      return new ConflictException(safe);
    return this.unavailable();
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: 'DOC_AUTHORIZATION_UNAVAILABLE',
      message: '文档授权暂不可用，请稍后重试',
    });
  }
}
