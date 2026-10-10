# Prints the position and size of each screen.
# Copy the X / Y of your vertical screen into start-dashboard.local.bat (POS_X / POS_Y).
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{
    Screen  = $_.DeviceName
    Primary = $_.Primary
    X       = $_.Bounds.X
    Y       = $_.Bounds.Y
    Width   = $_.Bounds.Width
    Height  = $_.Bounds.Height
  }
} | Format-Table -AutoSize
