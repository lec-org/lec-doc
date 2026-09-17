import { Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RedisModule } from '@nestjs-labs/nestjs-ioredis';
import { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { CollabWsAdapter } from '../adapter/collab-ws.adapter';
import { CollaborationConnectionRegistry } from '../collaboration-connection-registry.service';
import { CollaborationGateway } from '../collaboration.gateway';
import { CollaborationModule } from '../collaboration.module';
import { LoggerModule } from '../../common/logger/logger.module';
import { CaslModule } from '../../core/casl/casl.module';
import { LecBrowserSecurity } from '../../core/auth/lec-browser-security';
import { DatabaseModule } from '@docmost/db/database.module';
import { EnvironmentModule } from '../../integrations/environment/environment.module';
import { QueueModule } from '../../integrations/queue/queue.module';
import { RedisConfigService } from '../../integrations/redis/redis-config.service';
import { SecurityModule } from '../../integrations/security/security.module';
import { LecAuthorizationModule } from '../../core/lec-authorization/lec-authorization.module';
import { HealthModule } from '../../integrations/health/health.module';

@Module({
  imports: [
    LoggerModule,
    DatabaseModule,
    EnvironmentModule,
    SecurityModule,
    CaslModule,
    CollaborationModule,
    LecAuthorizationModule,
    QueueModule,
    HealthModule,
    EventEmitterModule.forRoot(),
    RedisModule.forRootAsync({ useClass: RedisConfigService }),
  ],
  providers: [CollaborationConnectionRegistry],
})
export class CollabAppModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CollabAppModule.name);
  private collabWsAdapter: CollabWsAdapter;

  constructor(
    private readonly collaborationGateway: CollaborationGateway,
    private readonly connectionRegistry: CollaborationConnectionRegistry,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly browserSecurity: LecBrowserSecurity,
  ) {}

  onModuleInit() {
    this.collaborationGateway.addExtension(this.connectionRegistry);
    this.collabWsAdapter = new CollabWsAdapter(this.browserSecurity);
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();
    const wss = this.collabWsAdapter.handleUpgrade('/collab', httpServer);

    wss.on('connection', (client: WebSocket, request: IncomingMessage) => {
      this.collaborationGateway.handleConnection(client, request);
      client.on('error', (error) =>
        this.logger.error('WebSocket client error:', error),
      );
    });
    wss.on('error', (error) =>
      this.logger.error('WebSocket server error:', error),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.collaborationGateway.destroy(this.collabWsAdapter);
    this.collabWsAdapter.destroy();
  }
}
