import { PrismaClient, Prisma } from '@prisma/client';

// Single Prisma client for the whole process.
export const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

// Type of the client inside prisma.$transaction(async (tx) => ...)
export type Tx = Prisma.TransactionClient;
