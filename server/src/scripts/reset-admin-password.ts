import { closePool } from '../db/connection.js';
import { resetLocalAdminPassword } from '../services/admin-password-reset.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { value += chunk; });
    process.stdin.on('end', () => resolve(value.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}

function getEmail(): string {
  const emailIndex = process.argv.indexOf('--email');
  if (emailIndex === -1 || !process.argv[emailIndex + 1]) {
    throw new Error('Usage: npm run admin:reset-password -- --email admin@example.com');
  }
  return process.argv[emailIndex + 1];
}

async function main(): Promise<void> {
  const email = getEmail();
  const password = process.env.ROBIN_ADMIN_NEW_PASSWORD ?? (!process.stdin.isTTY ? await readStdin() : '');
  if (!password) {
    throw new Error('Provide the new password through ROBIN_ADMIN_NEW_PASSWORD or standard input');
  }

  await resetLocalAdminPassword(email, password);
  process.stdout.write(`Password reset completed for ${email.trim().toLowerCase()}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`Password reset failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
