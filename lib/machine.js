/* Machine sheet (WMI), installed versions and the latest GitHub releases. */
const ctx = require('./context');
const { ps, psIsolated } = require('./powershell');
const { fetchJson, orNull } = require('./errors');

/* ---------- Machine sheet: hardware, drivers and update dates ----------
 * The dates (GPU driver, BIOS, last hotfix) feed the chart markers.
 * Lines split by real line breaks: joining with "; " would put a semicolon right
 * after "@{", which PowerShell rejects. */
const PS_MACHINE = `
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Basic|Remote|Meta|Virtual' } | Select-Object -First 1
$bb = Get-CimInstance Win32_BaseBoard
$bios = Get-CimInstance Win32_BIOS
$hf = Get-HotFix -ErrorAction SilentlyContinue | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
$ram = Get-CimInstance Win32_PhysicalMemory
$dd = Get-CimInstance Win32_DiskDrive
[pscustomobject]@{
  os = $os.Caption
  build = $os.BuildNumber
  cpu = $cpu.Name
  cores = $cpu.NumberOfCores
  threads = $cpu.NumberOfLogicalProcessors
  gpu = $gpu.Name
  gpuDriver = $gpu.DriverVersion
  gpuDriverDate = $(if ($gpu.DriverDate) { $gpu.DriverDate.ToString('yyyy-MM-dd') } else { $null })
  motherboard = ("{0} {1}" -f $bb.Manufacturer, $bb.Product).Trim()
  bios = $bios.SMBIOSBIOSVersion
  biosDate = $(if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { $null })
  hotfix = $hf.HotFixID
  hotfixDate = $(if ($hf.InstalledOn) { $hf.InstalledOn.ToString('yyyy-MM-dd') } else { $null })
  ram = @($ram | ForEach-Object { [pscustomobject]@{ gb = [int]($_.Capacity/1GB); mhz = [int]$_.Speed; part = "$($_.PartNumber)".Trim() } })
  disks = @($dd | ForEach-Object { [pscustomobject]@{ model = "$($_.Model)".Trim(); gb = [int]($_.Size/1GB) } })
} | ConvertTo-Json -Compress -Depth 4
`;

let machCache = { at: 0, data: null };
async function machine() {
  if (machCache.data && Date.now() - machCache.at < 12 * 3600 * 1000) return machCache.data;
  const rows = await psIsolated(PS_MACHINE);
  const m = rows && rows[0];
  if (m && (m.cpu || m.gpu)) machCache = { at: Date.now(), data: m };
  return machCache.data;
}

/* ---------- Version comparison ----------
 * Numeric: "0.9.6.0" equals "v0.9.6", and "0.100" is greater than "0.9". */
const versionParts = (s) => String(s || '').replace(/^v/i, '').split(/[.\-+_]/).map((n) => parseInt(n, 10) || 0);
function compareVersions(a, b) {           // -1: a < b (behind), 0: equal, 1: a > b
  const A = versionParts(a), B = versionParts(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/* ---------- Installed versions read from the Windows registry ----------
 * The uninstall keys list almost every program with its version, no path needed.
 * Matching on the repo name is a heuristic: an explicit path in localVersions wins. */
const PS_REGISTRY = `
$c = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $c -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and $_.DisplayVersion } |
  ForEach-Object { [pscustomobject]@{ n = "$($_.DisplayName)"; v = "$($_.DisplayVersion)" } } |
  ConvertTo-Json -Compress
`;
// "microsoft/PowerToys" -> "powertoys", applied to both sides of the comparison
const softwareKey = (s) => String(s || '').split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
// Build metadata ("0.9.6+3d331e…") is unreadable and useless.
const cleanVersion = (v) => String(v).trim().split('+')[0];

// The repo key must cover whole words of the display name, not the other way round:
// "vscode" must not catch "vs_codecoveragemsi", a Visual Studio component. CamelCase
// counts as separate words.
function coversWords(name, key) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((_, i) => {
    let run = '';
    for (const w of words.slice(i)) {
      run += w;
      if (run.length >= key.length) return run === key;
    }
    return false;
  });
}

// Among several candidates, the shortest name is the closest.
function versionFromRegistry(repo, rows) {
  const key = softwareKey(repo);
  if (key.length < 4) return null;                 // too short = too many homonyms
  let best = null;
  for (const r of rows) {
    if (coversWords(r.n, key) && (!best || r.n.length < best.n.length)) best = r;
  }
  return best ? cleanVersion(best.v) : null;
}

const trackedRepos = () => [...new Set((ctx.cfg.tools || []).flatMap((g) => g.releases || []))];

let instCache = { at: 0, data: {} };
async function installedVersions() {
  if (Date.now() - instCache.at < 6 * 3600 * 1000 && Object.keys(instCache.data).length) return instCache.data;
  const out = {};
  for (const [repo, exe] of Object.entries(ctx.cfg.localVersions || {})) {
    if (exe === 'auto') { out[repo] = process.version.replace(/^v/, ''); continue; }
    if (!exe) continue;
    const rows = await ps(`[pscustomobject]@{ v = (Get-Item '${String(exe).replace(/'/g, "''")}' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion } | ConvertTo-Json -Compress`, 10000);
    if (rows && rows[0] && rows[0].v) out[repo] = cleanVersion(rows[0].v);
  }
  const missing = trackedRepos().filter((r) => !out[r]);
  if (missing.length) {
    const rows = (await psIsolated(PS_REGISTRY)) || [];
    for (const repo of missing) {
      const v = versionFromRegistry(repo, rows);
      if (v) out[repo] = v;
    }
  }
  instCache = { at: Date.now(), data: out };
  return out;
}

/* ---------- Latest GitHub releases of the tracked repos ----------
 * The unauthenticated GitHub API allows 60 requests per hour. Each repo keeps its
 * last known release: a failed call (offline, quota reached) never erases it. While
 * a repo is missing, the next try comes after 30 min instead of 6 h. */
let relCache = { at: 0, data: {} };
async function latestReleases() {
  const repos = trackedRepos();
  const complete = repos.every((r) => relCache.data[r]);
  if (Date.now() - relCache.at < (complete ? 6 * 3600 : 30 * 60) * 1000) return relCache.data;
  relCache.at = Date.now();
  await Promise.all(repos.map(async (repo) => {
    const j = await orNull('GitHub', () => fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'user-agent': 'vigie', accept: 'application/vnd.github+json' },
    }));
    if (j && j.tag_name) relCache.data[repo] = { version: j.tag_name, name: j.name || '', date: j.published_at || null, url: j.html_url || null };
  }));
  return relCache.data;
}

async function releases() {
  const [rel, inst] = await Promise.all([latestReleases(), installedVersions()]);
  const out = {};
  for (const [repo, r] of Object.entries(rel)) {
    const installed = inst[repo] || null;
    out[repo] = { ...r, installed, outdated: installed ? compareVersions(installed, r.version) < 0 : null };
  }
  return out;
}

// Links allowed for /open (config.json + release URLs): never an arbitrary URL.
function knownToolUrls() {
  const urls = new Set();
  for (const g of ctx.cfg.tools || []) for (const l of g.links || []) if (l.url) urls.add(l.url);
  for (const r of Object.values(relCache.data)) if (r.url) urls.add(r.url);
  return urls;
}

module.exports = { compareVersions, versionFromRegistry, machine, releases, knownToolUrls };
