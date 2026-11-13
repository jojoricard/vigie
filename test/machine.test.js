const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, pickRelease, versionFromRegistry } = require('../lib/machine');

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

test('an installed version with a trailing .0 equals its tag: PowerToys is up to date', () => {
  assert.equal(compareVersions('0.102.3101.0', 'v0.102.3101'), 0);
  assert.equal(compareVersions('v1.2', '1.2.0.0'), 0);
  assert.equal(compareVersions('1.0', '1'), 0);
});

test('segments compare as numbers, whatever their count', () => {
  assert.equal(compareVersions('0.102.3101', '0.102.3200.0'), -1);
  assert.equal(compareVersions('1.10', '1.9.9'), 1);
  assert.equal(compareVersions('2', '1.99.99'), 1);
  assert.equal(compareVersions('24.14.0', 'v24.22.3'), -1);
  assert.equal(compareVersions('26.13.1', 'v24.22.3'), 1);
});

const rel = (tag_name, name = '', extra = {}) => ({ tag_name, name, prerelease: false, draft: false, ...extra });

test('alpha, beta, rc, nightly and canary releases are ignored, flagged by GitHub or not', () => {
  const list = [
    rel('v3.0.0-alpha.1'), rel('v3.0.0-beta.2'), rel('v3.0.0-rc.1'), rel('3.0.0rc2'), rel('nightly-2026-11-12'),
    rel('v3.0.0-canary.5'), rel('v3.0.0', '', { prerelease: true }), rel('v2.9.9', '', { draft: true }),
    rel('v2.4.1'), rel('v2.4.0'),
  ];
  assert.equal(pickRelease('owner/tool', list).tag_name, 'v2.4.1');
});

test('a tag that merely contains the letters of a marker is a normal release', () => {
  assert.equal(pickRelease('owner/tool', [rel('source-1.4.0')]).tag_name, 'source-1.4.0');
  assert.equal(pickRelease('owner/tool', [rel('arctic-2.0')]).tag_name, 'arctic-2.0');
});

test('the highest stable version wins over the most recent one', () => {
  // an older line patched after the new one came out
  assert.equal(pickRelease('spring-projects/spring-boot', [rel('v3.5.8'), rel('v4.0.0'), rel('v3.4.12')]).tag_name, 'v4.0.0');
});

test('node follows its latest LTS, not the alpha nor the Current line', () => {
  const list = [
    rel('v27.0.0-alpha.0.1.0', '2026-11-12, Version 27.0.0-alpha.0.1.0 (Alpha), @aduh95'),
    rel('v26.14.0', '2026-11-12, Version 26.14.0 (Current), @aduh95'),
    rel('v24.22.3', "2026-11-11, Version 24.22.3 'Krypton' (LTS), @aduh95"),
    rel('v22.23.5', "2026-11-11, Version 22.23.5 'Jod' (LTS), @aduh95"),
  ];
  assert.equal(pickRelease('nodejs/node', list).tag_name, 'v24.22.3');
  assert.equal(pickRelease('owner/other', list).tag_name, 'v26.14.0', 'the LTS rule is for node only');
});

test('a list without any stable release gives nothing', () => {
  assert.equal(pickRelease('owner/tool', [rel('v1.0.0-rc.1')]), null);
  assert.equal(pickRelease('owner/tool', []), null);
});
