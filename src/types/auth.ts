import type { Portal, Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  portals: Portal[];
  mfaVerified: boolean;
}
