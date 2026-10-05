#!/usr/bin/env node
/*
 * PRINTS THE SQL FOR THE FIRST PLATFORM ADMIN.
 *
 * On an empty database there is no way into the product at all. Every salon is
 * created by the platform admin console, every platform admin is created by the
 * seed, and the seed deletes and rebuilds a tenant -- which is the wrong tool
 * for a server. This is the missing first step, and the only one.
 *
 * It prints SQL rather than writing to a database on its own, so you can read
 * what it is about to do and run it wherever you run everything else.
 *
 *   node prisma/server-bootstrap/make-admin.js "you@yourdomain.com" "a long password"
 *
 * The password is hashed here and never leaves this machine. Do not commit the
 * output, and do not paste the password into a chat window, a ticket or a shell
 * history you keep -- `history -d` the line, or put a space before the command
 * if your shell is set to ignore those.
 *
 * Run it a second time with a new password to rotate: the statement updates the
 * row if that email already exists.
 */
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('Usage: node make-admin.js <email> <password>');
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`"${email}" does not look like an email address.`);
  process.exit(1);
}
if (password.length < 12) {
  // This account can create and delete every salon on the server. A short
  // password here is not a small risk taken on one account.
  console.error('Use at least 12 characters: this login can reach every salon on the server.');
  process.exit(1);
}

// Matches BCRYPT_ROUNDS in src/config/env.ts. Verification is bcrypt.compare,
// which reads the cost out of the hash, so this only has to be sane.
const hash = bcrypt.hashSync(password, 10);
const id = `pu_${crypto.randomBytes(12).toString('hex')}`;
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;

process.stdout.write(`-- Platform admin for ${email}. Generated ${new Date().toISOString()}.
-- Contains a password hash: do not commit this output.
INSERT INTO "platform_users" ("id", "name", "email", "passwordHash", "isActive", "createdAt", "updatedAt")
VALUES (${sql(id)}, 'Platform Admin', ${sql(email)}, ${sql(hash)}, true, now(), now())
ON CONFLICT ("email") DO UPDATE
  SET "passwordHash" = EXCLUDED."passwordHash",
      "isActive" = true,
      "updatedAt" = now();
`);
