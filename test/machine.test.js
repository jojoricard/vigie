const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, versionFromRegistry } = require('../lib/machine');

test('versions compare numerically, prefix and trailing zeros ignored', () => {
  assert.equal(compareVersions('0.9.6.0', 'v0.9.6'), 0);
  assert.equal(compareVersions('0.100', '0.9'), 1);
  assert.equal(compareVersions('24.14.0', 'v26.11.1'), -1);
});

test('the registry match needs the repo name inside the display name, shortest wins', () => {
  const rows = [
    { n: 'PowerToys (Preview) x64 Extra Tools', v: '0.1' },
    { n: 'PowerToys (Preview) x64', v: '0.95.1+abc' },
  ];
  assert.equal(versionFromRegistry('microsoft/PowerToys', rows), '0.95.1');
});

test('the registry match covers whole words, camelCase included', () => {
  const rows = [{ n: 'vs_codecoveragemsi', v: '18.7.11811' }, { n: 'Microsoft Visual Studio Code (User)', v: '1.141.0' }];
  assert.equal(versionFromRegistry('microsoft/vscode', rows), null);
  assert.equal(versionFromRegistry('nodejs/node', [{ n: 'Node.js', v: '24.14.0' }]), '24.14.0');
  assert.equal(versionFromRegistry('andyvorld/LGSTrayBattery', [{ n: 'LGSTrayBattery', v: '3.0.3' }]), '3.0.3');
  assert.equal(versionFromRegistry('owner/OBS-Studio', [{ n: 'OBS Studio', v: '31.0' }]), '31.0');
});

test('repo names under four characters are not matched', () => {
  assert.equal(versionFromRegistry('owner/vlc', [{ n: 'VLC media player', v: '3.0' }]), null);
});
