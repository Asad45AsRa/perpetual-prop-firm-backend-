import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../config/prisma';

export interface AuditInput {
  actorId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
}

// Writes one audit record. Pass a transaction client to make the audit
// record part of the same transaction as the change it describes.
export async function audit(input: AuditInput, client: Tx | typeof prisma = prisma) {
  await client.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      metadata: input.metadata,
      ip: input.ip,
    },
  });
}
