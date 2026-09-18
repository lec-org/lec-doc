import {
  execFileSync,
  spawn,
  ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface, Interface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Dialect, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent } from 'undici';
import { KyselyDB } from '../../database/types/kysely.types';
import { UserRepo } from '../../database/repos/user/user.repo';
import { LecImNotificationClient } from './lec-im-notification.client';
import { LecImNotificationDeliveryService } from './lec-im-notification-delivery.service';

const docUrl = process.env.LEC_DOC_TEST_DATABASE_URL;
const imUrl = process.env.LEC_IM_TEST_DATABASE_URL;

const issuer = 'https://id.example.test/oidc';
const subject = 'recipient-subject';
const token = 'document-notification-acceptance-token';
const genericText = '你获得了一篇云文档的访问权限';

type ImOutboxRow = {
  event_id: string;
  completed_at: string | null;
  suppressed_at: string | null;
  last_error: string;
  payload: string;
};
type WorkerResult = {
  processed: number;
  error?: string;
  rows: ImOutboxRow[];
  messages: Record<string, string>;
};

class ImAcceptanceServer {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly stdout: Interface;
  private readonly lines: string[] = [];
  private readonly waiters: Array<(line: string) => void> = [];
  private readonly errors: string[] = [];
  readonly ready: Promise<void>;

  constructor(
    binary: string,
    imDatabaseUrl: string,
    address: string,
    certFile: string,
    keyFile: string,
  ) {
    this.process = spawn(
      binary,
      ['-test.run', '^TestDocumentNotificationAcceptanceServer$'],
      {
        env: {
          ...process.env,
          TEST_DATABASE_URL: imDatabaseUrl,
          LEC_DOC_NOTIFICATION_TOKEN: token,
          LEC_IM_ACCEPTANCE_ADDR: address,
          LEC_IM_ACCEPTANCE_TLS_CERT: certFile,
          LEC_IM_ACCEPTANCE_TLS_KEY: keyFile,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.stdout = createInterface({ input: this.process.stdout });
    this.stdout.on('line', (line) => {
      const payload = line.startsWith('    ') ? line.slice(4) : line;
      if (
        payload.startsWith('=== RUN') ||
        payload.startsWith('--- PASS') ||
        payload === 'PASS'
      ) {
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(payload);
      else this.lines.push(payload);
    });
    this.process.stderr.on('data', (chunk) =>
      this.errors.push(chunk.toString()),
    );
    this.ready = this.waitFor((line) => line.includes('READY ')).then(
      () => undefined,
    );
  }

  private async waitFor(predicate: (line: string) => boolean): Promise<string> {
    for (;;) {
      const line =
        this.lines.shift() ??
        (await new Promise<string>((resolveLine, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(`LecIM acceptance timeout: ${this.errors.join('')}`),
              ),
            60_000,
          );
          this.waiters.push((value) => {
            clearTimeout(timer);
            resolveLine(value);
          });
        }));
      if (predicate(line)) return line;
    }
  }

  async command(command: Record<string, string>): Promise<void> {
    this.process.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async processEvents(): Promise<WorkerResult> {
    await this.command({ action: 'process' });
    const line = await this.waitFor((value) => value.includes('{'));
    return JSON.parse(line.slice(line.indexOf('{')));
  }

  async close() {
    const exited = new Promise<void>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        this.process.kill();
        reject(new Error('LecIM acceptance process did not exit'));
      }, 10_000);
      this.process.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolveExit();
        else
          reject(
            new Error(`LecIM acceptance exit ${code}: ${this.errors.join('')}`),
          );
      });
    });
    this.process.stdin.end();
    await exited;
    this.stdout.close();
  }
}

(docUrl && imUrl ? describe : describe.skip)(
  'Doc DB -> HTTPS LecIM -> LecIM DB/OpenIM acceptance',
  () => {
    const docDb: KyselyDB = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(docUrl, { max: 4 }),
      }) as unknown as Dialect,
      plugins: [new CamelCasePlugin()],
    });
    let server: ImAcceptanceServer;
    let tempDir: string;
    let workspaceId: string;
    let userId: string;
    let spaceId: string;
    let pageIds: string[];
    let eventIds: string[];
    let delivery: LecImNotificationDeliveryService;

    beforeAll(async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'lec-doc-im-acceptance-'));
      const certFile = join(tempDir, 'server.crt');
      const keyFile = join(tempDir, 'server.key');
      const caFile = join(tempDir, 'ca.crt');
      const openssl = spawn('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        keyFile,
        '-out',
        certFile,
      ]);
      await new Promise<void>((resolveExit, reject) => {
        openssl.once('exit', (code) =>
          code === 0
            ? resolveExit()
            : reject(new Error(`openssl exit ${code}`)),
        );
      });
      copyFileSync(certFile, caFile);

      const port = 20_000 + Math.floor(Math.random() * 20_000);
      const imDir = resolve(__dirname, '../../../../lec-im');
      const binary = join(tempDir, 'lec-im-notification-acceptance');
      execFileSync(
        process.env.GO_BINARY || '/usr/local/go/bin/go',
        ['test', '-c', './internal/documentnotification', '-o', binary],
        { cwd: imDir, stdio: 'inherit' },
      );
      server = new ImAcceptanceServer(
        binary,
        imUrl!,
        `127.0.0.1:${port}`,
        certFile,
        keyFile,
      );
      await server.ready;
      const config = new ConfigService({
        LEC_IM_NOTIFICATION_URL: `https://localhost:${port}/internal/v1/document-notifications`,
        LEC_DOC_NOTIFICATION_TOKEN: token,
        LEC_INTERNAL_CA_FILE: caFile,
      });
      const client = new LecImNotificationClient(config, {
        lease: async () => {
          const dispatcher = new Agent({
            connect: { ca: readFileSync(caFile, 'utf8') },
          });
          return {
            dispatcher,
            release: async () => dispatcher.close(),
          };
        },
      } as any);
      delivery = new LecImNotificationDeliveryService(
        docDb,
        new UserRepo(docDb),
        {
          validateCanView: async (page: { id: string }) => {
            if (page.id === pageIds[1]) throw new ForbiddenException();
            if (page.id === pageIds[2]) {
              throw new ServiceUnavailableException();
            }
          },
        } as any,
        client,
      );
    }, 120_000);

    beforeEach(async () => {
      workspaceId = randomUUID();
      userId = randomUUID();
      spaceId = randomUUID();
      pageIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      eventIds = pageIds.map(() => randomUUID());
      await docDb
        .insertInto('workspaces')
        .values({
          id: workspaceId,
          name: 'Cross-stack notification acceptance',
        })
        .execute();
      await docDb
        .insertInto('users')
        .values({
          id: userId,
          workspaceId,
          name: 'Recipient',
          email: `${userId}@example.test`,
        })
        .execute();
      await docDb
        .insertInto('lecIdentities')
        .values({ workspaceId, userId, issuer, subject })
        .execute();
      await docDb
        .insertInto('spaces')
        .values({
          id: spaceId,
          workspaceId,
          creatorId: userId,
          slug: `acceptance-${spaceId}`,
          name: 'Acceptance space',
        })
        .execute();
      await docDb
        .insertInto('pages')
        .values(
          pageIds.map((id, index) => ({
            id,
            workspaceId,
            spaceId,
            slugId: `acceptance-${id}`,
            title: `SECRET TITLE ${index}`,
            textContent: `SECRET BODY ${index}`,
            creatorId: userId,
            lastUpdatedById: userId,
          })),
        )
        .execute();
      await docDb
        .insertInto('notifications')
        .values(
          eventIds.map((id, index) => ({
            id,
            userId,
            workspaceId,
            pageId: pageIds[index],
            spaceId,
            type: 'page.permission_granted',
          })),
        )
        .execute();
      await docDb
        .insertInto('lecDocumentNotificationOutbox')
        .values(eventIds.map((notificationId) => ({ notificationId })))
        .execute();
    });

    afterEach(async () => {
      await docDb
        .deleteFrom('workspaces')
        .where('id', '=', workspaceId)
        .execute();
    });

    afterAll(async () => {
      await server?.close();
      await docDb.destroy();
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }, 30_000);

    it('delivers, suppresses, retries idempotently, freezes ambiguity, and sends generic payloads only', async () => {
      await server.command({ action: 'allow', resource_id: pageIds[0] });
      await server.command({ action: 'deny', resource_id: pageIds[1] });
      await server.command({ action: 'outage', resource_id: pageIds[2] });
      await server.command({ action: 'allow', resource_id: pageIds[3] });
      await server.command({ action: 'ambiguous', event_id: eventIds[3] });

      await (delivery as any).process({
        notificationId: eventIds[0],
        attempts: 1,
      });
      await (delivery as any).process({
        notificationId: eventIds[1],
        attempts: 1,
      });
      await (delivery as any).process({
        notificationId: eventIds[2],
        attempts: 1,
      });
      await (delivery as any).process({
        notificationId: eventIds[3],
        attempts: 1,
      });

      const docRows = await docDb
        .selectFrom('lecDocumentNotificationOutbox')
        .selectAll()
        .where('notificationId', 'in', eventIds)
        .execute();
      const docByID = new Map(docRows.map((row) => [row.notificationId, row]));
      expect(docByID.get(eventIds[0])?.completedAt).not.toBeNull();
      expect(docByID.get(eventIds[1])?.suppressedAt).not.toBeNull();
      expect(docByID.get(eventIds[2])?.completedAt).toBeNull();
      expect(docByID.get(eventIds[3])?.completedAt).not.toBeNull();

      let result = await server.processEvents();
      expect(result.error).toBeUndefined();
      const byID = new Map(result.rows.map((row) => [row.event_id, row]));
      expect(result.messages[eventIds[0]]).toBe(genericText);
      expect(result.messages[eventIds[1]]).toBeUndefined();
      expect(result.messages[eventIds[2]]).toBeUndefined();
      expect(result.messages[eventIds[3]]).toBe(genericText);
      expect(byID.get(eventIds[0])?.completed_at).not.toBeNull();
      expect(byID.get(eventIds[1])).toBeUndefined();
      expect(byID.get(eventIds[2])).toBeUndefined();
      expect(byID.get(eventIds[3])?.completed_at).not.toBeNull();
      expect(byID.get(eventIds[3])?.last_error).toContain(
        'manual review required',
      );

      const serialized = JSON.stringify(result);
      for (let index = 0; index < pageIds.length; index++) {
        expect(serialized).not.toContain(`SECRET TITLE ${index}`);
        expect(serialized).not.toContain(`SECRET BODY ${index}`);
      }
      expect(serialized).not.toContain('http://');
      expect(serialized).not.toContain('https://docs');

      await (delivery as any).process({
        notificationId: eventIds[0],
        attempts: 2,
      });
      result = await server.processEvents();
      expect(result.messages[eventIds[0]]).toBe(genericText);
      expect(
        result.rows.filter((row) => row.event_id === eventIds[0]),
      ).toHaveLength(1);
    }, 120_000);
  },
);
