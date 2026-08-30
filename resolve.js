const fs = require('fs');

function resolveFile(file, replacer) {
  let content = fs.readFileSync(file, 'utf8');
  content = replacer(content);
  fs.writeFileSync(file, content);
}

const regex = /<<<<<<< HEAD\r?\n[\s\S]*?=======\r?\n([\s\S]*?)>>>>>>> origin\/main\r?\n?/g;

['stellar-payment-platform/server.test.js',
 'stellar-payment-platform/tests/helmet.test.js',
 'stellar-payment-platform/tests/rate-limit.test.js',
 'stellar-payment-platform/tests/sentry.test.js'].forEach(f => {
  resolveFile(f, c => c.replace(regex, '$1'));
});

// src/db.js
resolveFile('stellar-payment-platform/src/db.js', c => {
  const r1 = /<<<<<<< HEAD\r?\n[\s\S]*?=======\r?\n([\s\S]*?)>>>>>>> origin\/main\r?\n?/;
  c = c.replace(r1, '$1');
  const r2 = /<<<<<<< HEAD\r?\n([\s\S]*?)=======\r?\n[\s\S]*?>>>>>>> origin\/main\r?\n?/;
  c = c.replace(r2, '$1');
  return c;
});

// userRoutes.js
resolveFile('stellar-payment-platform/src/routes/v1/userRoutes.js', c => {
  const r = /<<<<<<< HEAD\r?\n[\s\S]*?=======\r?\n[\s\S]*?>>>>>>> origin\/main\r?\n?/g;
  return c.replace(r, "    if (error.code === '23505' || error.code === 'P2002' || (error.message && error.message.includes('UNIQUE'))) {\n");
});
