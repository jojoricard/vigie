/* Now playing, from Windows' media session (the one behind the volume flyout): any
 * player that declares itself, Spotify, a browser tab, VLC... */
const { ps, psIsolated } = require('./powershell');

/* WinRT from Windows PowerShell 5.1: AsTask through reflection to wait for the async
 * calls. The manager is kept in the interpreter between calls: requesting a new one each
 * time grew it by 15 MB over 3000 calls. Cleared while in use, so a call that throws
 * starts from a fresh one. No double quote in these scripts, they go through JS strings. */
const PS_INIT = `
if (-not $global:npAsTask) {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $global:npAsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -match '^IAsyncOperation.1$' } | Select-Object -First 1
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
}
function npAwait($op, [Type]$type) {
  $t = $global:npAsTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $t.Wait(5000)) { throw 'WinRT timeout' }
  $t.Result
}
$props = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = $global:npMgr; $global:npMgr = $null
if (-not $mgr) { $mgr = npAwait ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }
`;

const PS_NOW = PS_INIT + `
$s = $mgr.GetCurrentSession()
$out = [pscustomobject]@{ app = $null }
if ($s) {
  $p = npAwait ($s.TryGetMediaPropertiesAsync()) $props
  $out = [pscustomobject]@{ app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; status = $s.GetPlaybackInfo().PlaybackStatus.ToString().ToLower() }
}
$global:npMgr = $mgr
$out | ConvertTo-Json -Compress
`;

const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/* The session is found again by its app id, and by its title if the app has several:
 * the current session may have changed since the page was drawn. Play or pause rather
 * than toggle, which would restart a player paused from the keyboard in the meantime. */
const psAction = (app, title, action) => PS_INIT + `
$c = @($mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -eq ${quote(app)} })
if ($c.Count -gt 1) { $c = @($c | Where-Object { (npAwait ($_.TryGetMediaPropertiesAsync()) $props).Title -eq ${quote(title)} }) }
$ok = $false
if ($c.Count -eq 1) { $ok = npAwait ($c[0].${action === 'pause' ? 'TryPauseAsync' : 'TryPlayAsync'}()) ([bool]) }
$global:npMgr = $mgr
[pscustomobject]@{ ok = $ok } | ConvertTo-Json -Compress
`;

// The session only gives an app id (Firefox's is a hash of its path): the Start menu
// knows its name. Looked up once per id, in its own process (half a second).
const appNames = new Map();
async function appName(id) {
  if (!appNames.has(id)) {
    appNames.set(id, null);
    const r = await psIsolated(`Get-StartApps | Where-Object { $_.AppID -eq ${quote(id)} } | Select-Object -First 1 Name | ConvertTo-Json -Compress`);
    if (r && r[0] && r[0].Name) appNames.set(id, r[0].Name);
  }
  return appNames.get(id);
}

// A paused player stays shown a few minutes, long enough to press play again. After
// that, a tab paused hours ago would sit on the Overview for nothing.
const PAUSED_SHOWN_MS = 5 * 60 * 1000;
let lastPlaying = { key: null, at: 0 };
let shown = null;
let cache = { at: 0, data: null };

async function nowPlaying() {
  if (Date.now() - cache.at < 2000) return cache.data;
  const r = await ps(PS_NOW, 10000);
  if (!r) return cache.data;                 // PowerShell failed, logged: keep the last answer
  const s = r[0];
  let data = null;
  if (s.app) {
    const key = s.app + '|' + s.title;
    if (s.status === 'playing') lastPlaying = { key, at: Date.now() };
    if (s.status === 'playing' || (key === lastPlaying.key && Date.now() - lastPlaying.at < PAUSED_SHOWN_MS)) {
      data = { title: s.title, artist: s.artist, status: s.status, name: await appName(s.app) };
      shown = s;
    }
  }
  cache = { at: Date.now(), data };
  return data;
}

// Acts on the session the agent showed last, never on an id sent by the page.
async function mediaAction(action) {
  if (!shown || (action !== 'play' && action !== 'pause')) return false;
  const r = await ps(psAction(shown.app, shown.title, action), 10000);
  cache.at = 0;
  return !!(r && r[0].ok);
}

module.exports = { nowPlaying, mediaAction };
