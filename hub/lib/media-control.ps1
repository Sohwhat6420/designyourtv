# One media-key press on this laptop's current Windows media session (Spotify, YouTube in a browser, …), through the
# same WinRT session manager win-sensors.ps1 reads. Run by hub/lib/media-control.mjs with windowsHide, one press per
# run; prints one JSON line: {"ok":true,"act":"playpause"} or {"ok":false,"why":"…"}.
param([ValidateSet('playpause', 'next', 'prev')][string]$Act = 'playpause')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(5000); if ($t.IsCompleted) { $t.Result } else { $null } }
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  if ($null -eq $mgr) { throw 'RequestAsync timed out' }
  $s = $mgr.GetCurrentSession()
  if ($null -eq $s) { Emit @{ ok = $false; act = $Act; why = 'nothing is playing' }; exit 0 }
  $op = switch ($Act) { 'playpause' { $s.TryTogglePlayPauseAsync() } 'next' { $s.TrySkipNextAsync() } 'prev' { $s.TrySkipPreviousAsync() } }
  $done = Await $op ([bool])
  Emit @{ ok = [bool]$done; act = $Act; app = "$($s.SourceAppUserModelId)" }
} catch {
  Emit @{ ok = $false; act = $Act; why = $_.Exception.Message }
}
