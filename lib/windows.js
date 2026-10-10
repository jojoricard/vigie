/* Windows waiting for the user: a reboot, or updates to install. Shown as a pill only
 * when it's the case. */
const { ps, psIsolated } = require('./powershell');

/* Only the reliable flags. PendingFileRenameOperations is left out on purpose: installers
 * leave files there to delete at the next boot, so it is set most of the time. The parent
 * keys are listed rather than the flag keys opened: listing only needs read access. */
const PS_REBOOT = `
$lm = [Microsoft.Win32.Registry]::LocalMachine
function subKeys($path) { $k = $lm.OpenSubKey($path); if ($k) { $k.GetSubKeyNames(); $k.Close() } }
$reasons = @()
$cbs = subKeys 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing'
if ($cbs -contains 'RebootPending' -or $cbs -contains 'RebootInProgress') { $reasons += 'servicing' }
if ((subKeys 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update') -contains 'RebootRequired') { $reasons += 'windowsUpdate' }
$cn = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\'
if ((Get-ItemProperty ($cn + 'ActiveComputerName')).ComputerName -ne (Get-ItemProperty ($cn + 'ComputerName')).ComputerName) { $reasons += 'rename' }
[pscustomobject]@{ reasons = @($reasons) } | ConvertTo-Json -Compress
`;

/* Offline search: reads what Windows' own last scan found, without a network scan of
 * our own (an online search takes 4 to 9 s and logs an event each time). Antivirus
 * definitions are left out, Defender installs them by itself several times a day, and
 * so are optional updates. About 1 s, hence its own process. */
const PS_UPDATES = `
$s = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
$s.Online = $false
$r = $s.Search('IsInstalled=0 and IsHidden=0 and Type=''Software''')
if ($r.ResultCode -ne 2) { throw ('search result ' + $r.ResultCode) }
$titles = @($r.Updates | Where-Object { -not $_.BrowseOnly -and -not ($_.Categories | Where-Object { $_.CategoryID -eq 'e0789628-ce08-4437-be74-2495b842f43b' }) } |
  ForEach-Object { $_.Title })
[pscustomobject]@{ titles = $titles } | ConvertTo-Json -Compress
`;

let rebootCache = { at: 0, data: null };
let updatesCache = { at: 0, data: null };

async function windowsStatus() {
  if (Date.now() - rebootCache.at > 10 * 60 * 1000) {
    const r = await ps(PS_REBOOT, 15000);
    if (r) rebootCache = { at: Date.now(), data: r[0].reasons };
  }
  if (Date.now() - updatesCache.at > 3600 * 1000) {
    const u = await psIsolated(PS_UPDATES, 60000);
    if (u) updatesCache = { at: Date.now(), data: u[0].titles };
  }
  return { reboot: rebootCache.data, updates: updatesCache.data };
}

module.exports = { windowsStatus };
