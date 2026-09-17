import { z } from 'zod';

export const capabilitySchema = z.enum([
  'VIEW',
  'COMMENT',
  'EDIT',
  'DELETE',
  'CREATE',
  'CLASSIFY',
  'TRANSFER_OWNER',
  'MANAGE_GRANTS',
  'REVIEW_ACCESS_REQUEST',
  'RESTORE',
]);
export type LecCapability = z.infer<typeof capabilitySchema>;
export const resourceKindSchema = z.enum(['DOCMOST_SPACE', 'DOCMOST_PAGE']);
export const principalSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ANONYMOUS') }),
  z.strictObject({
    type: z.literal('OIDC'),
    issuer: z.url(),
    subject: z.string().min(1).max(255),
  }),
]);
export type LecPrincipal = z.infer<typeof principalSchema>;
export const policyItemSchema = z.strictObject({
  resource_kind: resourceKindSchema,
  resource_id: z.uuid(),
  capability: capabilitySchema,
});
export type LecPolicyItem = z.infer<typeof policyItemSchema>;
export const decisionSchema = policyItemSchema
  .extend({
    item_id: z.string().min(1).max(128),
    workspace_id: z.uuid(),
    organization_id: z.uuid().nullable(),
    resource_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    allowed: z.boolean(),
    reason_code: z.enum(['ALLOW', 'NOT_ALLOWED']),
  })
  .refine(
    (d) =>
      d.allowed === (d.reason_code === 'ALLOW') &&
      (d.organization_id === null) === (d.resource_version === 0) &&
      (!d.allowed || d.resource_version > 0),
  );
export type LecDecision = z.infer<typeof decisionSchema>;
export const batchResponseSchema = z.strictObject({
  data: z.strictObject({
    request_id: z.string().min(1).max(128),
    items: z.array(decisionSchema).min(1).max(100),
  }),
});
export const resourceSchema = z.strictObject({
  workspace_id: z.uuid(),
  resource_kind: resourceKindSchema,
  resource_id: z.uuid(),
  organization_id: z.uuid(),
  parent_kind: resourceKindSchema.nullable(),
  parent_id: z.uuid().nullable(),
  owner_user_id: z.uuid(),
  classification: z.number().int().min(1).max(5),
  state: z.enum(['RESERVED', 'ACTIVE', 'DELETED', 'CANCELLED']),
  resource_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  registration_key: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type LecResource = z.infer<typeof resourceSchema>;
export const resourceEnvelopeSchema = z.strictObject({ data: resourceSchema });
export const reparentEnvelopeSchema = z.strictObject({
  data: resourceSchema.extend({
    operation_id: z.uuid(),
    operation_status: z.enum(['PREPARED', 'COMMITTED', 'CANCELLED']),
  }),
});
export const accessRequestEnvelopeSchema = z.strictObject({
  data: z.strictObject({
    id: z.uuid(),
    workspace_id: z.uuid(),
    resource_kind: resourceKindSchema,
    resource_id: z.uuid(),
    user_id: z.uuid(),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED']),
    reason: z.string().min(1).max(1000),
    reviewed_by: z.uuid().nullable(),
    expires_at: z.iso.datetime({ offset: true }).nullable(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  }),
});
export const treeResponseSchema = z.strictObject({
  data: z.strictObject({
    operation_id: z.uuid(),
    resource_kind: resourceKindSchema,
    resource_id: z.uuid(),
    items: z.array(resourceSchema).min(1).max(1000),
  }),
});
export type LecTreeResponse = z.infer<typeof treeResponseSchema>['data'];
