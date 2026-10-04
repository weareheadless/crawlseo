import { db } from "../lib/db";
import { hashPassword } from "../lib/local-auth";

const email = process.env.LOCAL_AUTH_EMAIL?.trim().toLowerCase();
const password = process.env.LOCAL_AUTH_PASSWORD;

if (!email || !password) {
  throw new Error("LOCAL_AUTH_EMAIL and LOCAL_AUTH_PASSWORD are required");
}

const configuredEmail = email;

if (password.length < 12) {
  throw new Error("LOCAL_AUTH_PASSWORD must be at least 12 characters");
}

const configuredPassword = password;

async function main() {
  const passwordHash = await hashPassword(configuredPassword);
  const user = await db.user.upsert({
    where: { email: configuredEmail },
    update: { passwordHash },
    create: { email: configuredEmail, passwordHash, name: configuredEmail.split("@")[0] },
  });

  await db.session.deleteMany({ where: { userId: user.id } });
  await db.$disconnect();
  console.log(`Local password configured for ${configuredEmail}`);
}

main().catch(async (error) => {
  await db.$disconnect();
  throw error;
});
