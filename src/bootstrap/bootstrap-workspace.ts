import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { BootstrapModule } from './bootstrap.module';
import { BootstrapWorkspaceService } from './bootstrap-workspace.service';
import { LecResourceLifecycleService } from '../core/lec-authorization/lec-resource-lifecycle.service';

const envSchema = z.object({
  LEC_DOC_BOOTSTRAP_WORKSPACE_ID: z.uuid(),
  LEC_DOC_BOOTSTRAP_WORKSPACE_NAME: z.string().trim().min(1).max(100),
  LEC_DOC_ORGANIZATION_ID: z.uuid(),
  LEC_DOC_BOOTSTRAP_SPACE_NAME: z.string().trim().min(1).max(100),
  LEC_DOC_BOOTSTRAP_SPACE_SLUG: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  LEC_DOC_BOOTSTRAP_OWNER_ISSUER: z.url(),
  LEC_DOC_BOOTSTRAP_OWNER_SUBJECT: z.string().trim().min(1).max(255),
  LEC_DOC_BOOTSTRAP_OWNER_EMAIL: z.email(),
  LEC_DOC_BOOTSTRAP_OWNER_NAME: z.string().trim().min(1).max(100),
});

async function main() {
  const env = envSchema.parse(process.env);
  const app = await NestFactory.createApplicationContext(BootstrapModule, {
    logger: ['error', 'warn'],
  });
  try {
    const result = await app.get(BootstrapWorkspaceService).bootstrap({
      workspaceId: env.LEC_DOC_BOOTSTRAP_WORKSPACE_ID,
      workspaceName: env.LEC_DOC_BOOTSTRAP_WORKSPACE_NAME,
      organizationId: env.LEC_DOC_ORGANIZATION_ID,
      defaultSpaceName: env.LEC_DOC_BOOTSTRAP_SPACE_NAME,
      defaultSpaceSlug: env.LEC_DOC_BOOTSTRAP_SPACE_SLUG,
      ownerIssuer: env.LEC_DOC_BOOTSTRAP_OWNER_ISSUER,
      ownerSubject: env.LEC_DOC_BOOTSTRAP_OWNER_SUBJECT,
      ownerEmail: env.LEC_DOC_BOOTSTRAP_OWNER_EMAIL,
      ownerName: env.LEC_DOC_BOOTSTRAP_OWNER_NAME,
    });
    // The durable operation exists before Core is called. Failure is safe to retry.
    const lifecycle = app.get(LecResourceLifecycleService);
    const principal = {
      type: 'OIDC' as const,
      issuer: new URL(env.LEC_DOC_BOOTSTRAP_OWNER_ISSUER).href,
      subject: env.LEC_DOC_BOOTSTRAP_OWNER_SUBJECT,
    };
    const owner = { id: result.ownerUserId, workspaceId: result.workspaceId };
    await lifecycle.ensureSpaceBound(owner, principal, result.spaceId);
    await lifecycle.ensureSpaceBound(owner, principal, result.personalSpaceId);
    process.stdout.write(
      `${JSON.stringify({ ...result, coreBinding: 'done' })}\n`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  Logger.error(
    error instanceof Error ? error.message : 'workspace bootstrap failed',
    undefined,
    'BootstrapWorkspace',
  );
  process.exitCode = 1;
});
