// Cross-platform entry point for `npm run test:load:webhooks`: seeds test
// users, starts the mock receiver, runs Artillery, then cleans up.
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', shell: true });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });

const main = async () => {
  await run('node', ['scripts/seed-webhook-load-test-users.js']);

  const receiver = spawn('node', ['scripts/mock-webhook-receiver.js'], { cwd: ROOT, stdio: 'inherit', shell: true });
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    await run('npx', ['artillery', 'run', 'artillery-webhooks.yml']);
  } finally {
    receiver.kill();
  }
};

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
