/**
 * Prisma client singleton for OpenRundown
 * Provides type-safe database access
 */

import { PrismaClient } from "@prisma/client";

// PrismaClient is attached to the `global` object to prevent
// exhausting your database connection limit during development/hot-reloads.
// In production, a single instance is used for the lifetime of the process.
// Learn more: https://pris.ly/d/help/next-js-best-practices

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

// Always cache the prisma instance to prevent connection leaks
// This is safe in all environments - the singleton pattern ensures
// we reuse the same connection pool across the application
globalForPrisma.prisma = prisma;

// Ensure cleanup on process exit
process.on("beforeExit", async () => {
  await prisma.$disconnect();
});

/**
 * Close database connection
 */
export async function closePrisma(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Check if database is connected
 */
export async function checkPrismaConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
