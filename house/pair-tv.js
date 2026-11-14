/* Pairs the house service with an LG television, once: the set asks on its screen
 * whether to accept, and the key it answers with goes in the config of the device.
 *   node house/pair-tv.js 192.168.1.20
 * The television must be on. Nothing is written anywhere: the key is printed. */
const { create } = require('./drivers/lg-webos');
const { DeviceError } = require('./util');

const host = process.argv[2];
if (!host) {
  console.error('Usage: node house/pair-tv.js <address of the television>');
  process.exit(2);
}
create().pair(host, { onPrompt: () => console.log('Accept the request on the screen of the television (60 s)…') }).then((key) => {
  console.log(`Paired. In config.json, on the device of the television:\n  "driver": "lg-webos", "host": "${host}", "key": "${key}", "mac": "<its MAC address, to turn it on>"`);
}, (e) => {
  if (!(e instanceof DeviceError)) throw e;
  console.error(e.message);
  process.exit(1);
});
