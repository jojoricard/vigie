# Hides the Vigie window from Alt+Tab and the taskbar (WS_EX_TOOLWINDOW).
param([string]$Title = 'Vigie', [int]$TimeoutSec = 20)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@
$GWL_EXSTYLE = -20; $WS_EX_TOOLWINDOW = 0x80; $WS_EX_APPWINDOW = 0x40000
$deadline = (Get-Date).AddSeconds($TimeoutSec)
do {
  $found = [IntPtr]::Zero
  [W]::EnumWindows({ param($h, $p)
    $sb = New-Object Text.StringBuilder 256
    [void][W]::GetWindowText($h, $sb, 256)
    if ([W]::IsWindowVisible($h) -and $sb.ToString() -like "*$Title*") { $script:found = $h; return $false }
    return $true }, [IntPtr]::Zero) | Out-Null
  if ($found -ne [IntPtr]::Zero) {
    $ex = [W]::GetWindowLongPtr($found, $GWL_EXSTYLE).ToInt64()
    $ex = ($ex -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)
    [W]::ShowWindow($found, 0) | Out-Null          # hide, change style, show again
    [W]::SetWindowLongPtr($found, $GWL_EXSTYLE, [IntPtr]$ex) | Out-Null
    [W]::ShowWindow($found, 5) | Out-Null
    exit 0
  }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
exit 1