import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

// Run with: npm run db:seed
// Safe to run many times: it only creates what is missing.
const prisma = new PrismaClient();

async function main() {
  // ---- Super admin (created once, protected from deletion) ----
  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in your .env file');

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!existing) {
    await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash: await bcrypt.hash(password, 12),
        role: 'SUPER_ADMIN',
        displayName: 'Super Admin',
        portals: [],
        isProtected: true,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        referralCode: randomBytes(4).toString('hex').toUpperCase(),
      },
    });
    console.log(`Super admin created: ${email} (you must enable MFA on first login)`);
  } else {
    console.log('Super admin already exists');
  }

  // ---- Placeholder plans. Real values must be approved by the client. ----
  if ((await prisma.plan.count()) === 0) {
    const sizes = [5000, 10000, 25000, 50000, 100000];
    for (const size of sizes) {
      await prisma.plan.create({
        data: {
          name: `$${size / 1000}K Challenge`,
          accountSize: size,
          price: Math.round(size * 0.01), // placeholder price
          profitTargetPct: 8,
          dailyLossPct: 5,
          maxDrawdownPct: 10,
          maxLeverage: 20,
        },
      });
    }
    console.log('Placeholder plans created');
  }

  // ---- Empty editable content blocks ----
  for (const key of ['faq', 'rules']) {
    await prisma.contentBlock.upsert({
      where: { key },
      create: { key, title: key.toUpperCase(), data: { items: [] } },
      update: {},
    });
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
