import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const getPrisma = () => {
  if (!globalForPrisma.prisma) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set");
    }

    const adapter = new PrismaMariaDb(process.env.DATABASE_URL);

    globalForPrisma.prisma = new PrismaClient({
      adapter,
      log: ["error", "warn"],
    });
  }

  return globalForPrisma.prisma;
};
