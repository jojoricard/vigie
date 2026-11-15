/* Pairs the house service with the Freebox, once: the box asks on its own screen whether
 * to accept the application, and the token it gives goes in the config.
 *   node house/pair-freebox.js [address]        (mafreebox.freebox.fr by default)
 *   node house/pair-freebox.js --devices <token>  lists what the box sees, with addresses, to pick the phones
 * Nothing is written anywhere: the token is printed. */
const { create } = require('./drivers/freebox');
const { DeviceError } = require('./util');

const args = process.argv.slice(2);
const done = (e) => {
  if (!(e instanceof DeviceError)) throw e;
  console.error(e.message);
  process.exit(1);
};

if (args[0] === '--devices') {
  create({ appToken: args[1], host: args[2] }).list().then((hosts) => {
    // what is on the network now comes first, with its address: the television to pair is one of them
    for (const h of [...hosts].sort((x, y) => y.active - x.active)) console.log(`${h.active ? '●' : '○'} ${h.mac}  ${(h.ip || '').padEnd(15)}  ${h.name || ''}`);
    console.log('\nIn config.json, under house.freebox.people: { "id": "me", "name": "Me", "devices": ["<the MAC of a phone>"] }');
  }, done);
} else {
  const host = args[0];
  create(host ? { host } : {}).pair({ onPrompt: () => console.log('Press the right arrow on the screen of the Freebox to accept "Vigie" (90 s)…') }).then((token) => {
    console.log(`Paired. In config.json:\n  "house": { "freebox": { ${host ? `"host": "${host}", ` : ''}"appToken": "${token}", "people": [] } }`);
    console.log(`Then: node house/pair-freebox.js --devices "${token}"${host ? ` ${host}` : ''}   to find the phones to follow.`);
  }, done);
}
