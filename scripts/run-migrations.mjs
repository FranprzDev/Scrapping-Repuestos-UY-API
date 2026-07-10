import { spawn } from 'node:child_process';

const maxAttempts = 12;
const retryDelayMs = 5000;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = await runMigration();
  if (result.code === 0) {
    process.exit(0);
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const lockBusy = /Another migration is already running|migration lock/i.test(output);
  if (!lockBusy || attempt === maxAttempts) {
    process.exit(result.code || 1);
  }

  console.warn(`Migration lock ocupado; reintentando ${attempt}/${maxAttempts} en ${retryDelayMs / 1000}s`);
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
}

function runMigration() {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'node-pg-migrate', 'up'], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
