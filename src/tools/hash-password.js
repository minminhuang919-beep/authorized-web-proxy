#!/usr/bin/env node
/**
 * Print an scrypt hash for ADMIN_PASSWORD_HASH.
 *
 *   npm run hash-password            (prompts, input hidden)
 *   npm run hash-password -- 'pw'    (argument; beware of shell history)
 */
import { createInterface } from 'node:readline';
import { hashPassword } from '../security/password.js';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function validate(password) {
  if (password.length < 12) fail('Password must be at least 12 characters long.');
  if (['password', 'changeme', 'admin'].some((w) => password.toLowerCase().includes(w))) fail('Password is too weak (contains a common word).');
}

async function prompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const muted = { on: false };
  rl._writeToOutput = function (str) {
    if (muted.on) return;
    rl.output.write(str);
  };
  const ask = (q) =>
    new Promise((resolve) => {
      rl.question(q, (answer) => {
        rl.output.write('\n');
        resolve(answer);
      });
      muted.on = true;
    });
  const first = await ask('Password: ');
  muted.on = false;
  const second = await ask('Repeat:   ');
  rl.close();
  if (first !== second) fail('Passwords do not match.');
  return first;
}

const password = process.argv[2] !== undefined ? process.argv[2] : await prompt();
validate(password);
console.log(hashPassword(password));
