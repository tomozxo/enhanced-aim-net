// Command-line key management, as an alternative to the admin web panel.
//   node server/cli.js new "buyer note" 30      (30-day expiry, optional)
//   node server/cli.js admin "your name"        (mint an admin key - bootstraps panel access)
//   node server/cli.js list
//   node server/cli.js unlock R6S-XXXX-XXXX-XXXX-XXXX
//   node server/cli.js revoke R6S-XXXX-XXXX-XXXX-XXXX
//
// Uses the same storage as the server: with DATABASE_URL set (in .env or the
// shell), it manages the keys in that database.

require('dotenv').config();
const store = require('./store');

const [, , cmd, ...args] = process.argv;

async function main() {
  await store.init();

  if (cmd === 'new') {
    const [note, plan] = args;
    if (plan && !store.isPlan(plan)) {
      console.log(`Unknown length "${plan}". Use one of: ${Object.keys(store.PLANS).join(', ')}.`);
      return;
    }
    const record = await store.createKey({ note, plan: plan || 'lifetime' });
    console.log('Created key:', record.key);
    console.log(record);
  } else if (cmd === 'admin') {
    const [note] = args;
    const record = await store.createKey({ note: note || 'admin', isAdmin: true });
    console.log('Created ADMIN key:', record.key);
    console.log('Enter this on the site (same activation screen as everyone else) - it will drop you straight into /admin.html.');
    console.log(record);
  } else if (cmd === 'list') {
    console.table(
      (await store.listKeys()).map((k) => ({
        key: k.key,
        status: k.status,
        admin: k.isAdmin ? 'yes' : '',
        note: k.note,
        lockedDevice: k.lockedDeviceId ? k.lockedDeviceId.slice(0, 10) + '…' : '-',
        activatedAt: k.activatedAt || '-',
        expiresAt: k.expiresAt || 'never',
      }))
    );
  } else if (cmd === 'unlock') {
    const [key] = args;
    const updated = await store.unlockKey((key || '').toUpperCase());
    console.log(updated ? `Unlocked ${updated.key}` : 'Key not found.');
  } else if (cmd === 'revoke') {
    const [key] = args;
    const updated = await store.revokeKey((key || '').toUpperCase());
    console.log(updated ? `Revoked ${updated.key}` : 'Key not found.');
  } else {
    console.log(
      'Usage:\n' +
        '  node server/cli.js new [note] [8h|1w|lifetime]   (default: lifetime)\n' +
        '  node server/cli.js admin [note]\n' +
        '  node server/cli.js list\n' +
        '  node server/cli.js unlock <key>\n' +
        '  node server/cli.js revoke <key>'
    );
  }
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => store.close());
