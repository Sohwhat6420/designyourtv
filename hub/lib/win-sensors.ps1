# Windows sensors for the hub and the device agent: one long-lived, windowless PowerShell that prints one JSON line
# per reading on stdout, so Node never has to start a process per poll.
#   {"kind":"np", ...}        the Windows media session (what is playing), every 3 s
#   {"kind":"net", ...}       total bytes received and sent on the up, non-loopback adapters, every 2 s
#   {"kind":"battery", ...}   Win32_Battery, every 60 s (an empty reading on a desktop with no battery)
#   {"kind":"commit", ...}    committed memory and the commit limit in GB (Win32_OperatingSystem), every 10 s
#   {"kind":"idle", "s":N}   seconds since the last keyboard or mouse input (GetLastInputInfo), every 5 s; it drives the
#                             wallpaper's AOD look. Only meaningful in the owner's desktop session (the agent's logon task is)
#   {"kind":"error", ...}     a sensor that failed; the others keep going
# Started by hub/lib/system-stats.mjs with windowsHide and the parent's PID as its argument; it exits when that
# process has gone, so it can never outlive the hub or the agent.
# Reads only. Nothing here changes a setting.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

# ---- the media session, through WinRT (GlobalSystemMediaTransportControlsSessionManager) ----
$np = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(5000); if ($t.IsCompleted) { $t.Result } else { $null } }
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  if ($null -eq $mgr) { throw 'RequestAsync timed out' }
  $np = @{ mgr = $mgr; propsType = $propsType }
} catch {
  Emit @{ kind = 'np'; status = 'unavailable'; why = ('WinRT media session: ' + $_.Exception.Message) }
}

function Read-NowPlaying {
  $s = $np.mgr.GetCurrentSession()
  if ($null -eq $s) { return @{ kind = 'np'; status = 'none' } }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ($np.propsType)
  $pb = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $status = "$($pb.PlaybackStatus)".ToLower()          # playing, paused, stopped, changing, opened, closed
  $pos = $tl.Position.TotalSeconds
  # The position is only as fresh as LastUpdatedTime; while playing, carry it forward to now.
  if ($status -eq 'playing' -and $tl.LastUpdatedTime.Year -gt 2000) {
    $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
  }
  $dur = ($tl.EndTime - $tl.StartTime).TotalSeconds
  if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
  return @{ kind = 'np'; status = $status; title = "$($p.Title)"; artist = "$($p.Artist)"; album = "$($p.AlbumTitle)";
    position_s = [math]::Round([math]::Max(0, $pos), 1); duration_s = [math]::Round([math]::Max(0, $dur), 1); app = "$($s.SourceAppUserModelId)" }
}

# ---- idle time: user32 GetLastInputInfo (input to this desktop session only) ----
$idleOk = $false
try {
  Add-Type -Namespace TvHub -Name Idle -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
public static double Seconds() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); if (!GetLastInputInfo(ref i)) return -1; return unchecked((uint)Environment.TickCount - i.dwTime) / 1000.0; }
'@
  $idleOk = $true
} catch { Emit @{ kind = 'error'; sensor = 'idle'; why = $_.Exception.Message } }

function Read-Net {
  $rx = [int64]0; $tx = [int64]0
  foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($n.OperationalStatus -ne 'Up') { continue }
    if ($n.NetworkInterfaceType -eq 'Loopback' -or $n.NetworkInterfaceType -eq 'Tunnel') { continue }
    $st = $n.GetIPStatistics(); $rx += $st.BytesReceived; $tx += $st.BytesSent
  }
  return @{ kind = 'net'; rx = $rx; tx = $tx; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
}

function Read-Battery {
  $b = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1
  if ($null -eq $b) { return @{ kind = 'battery'; present = $false } }
  # BatteryStatus: 1 discharging, 2 on mains, 3 full, 6-9 charging (CIM_Battery)
  $st = [int]$b.BatteryStatus
  return @{ kind = 'battery'; present = $true; pct = [int]$b.EstimatedChargeRemaining; status = $st;
    charging = ($st -ge 6 -and $st -le 9); plugged = ($st -eq 2 -or $st -eq 3 -or ($st -ge 6 -and $st -le 9)) }
}

# Committed memory against the commit limit (RAM plus page file): the number the owner's 75% / 85% gates are measured in.
function Read-Commit {
  $os = Get-CimInstance -ClassName Win32_OperatingSystem
  $total = [double]$os.TotalVirtualMemorySize; $used = $total - [double]$os.FreeVirtualMemory   # both in KB
  return @{ kind = 'commit'; used_gb = [math]::Round($used / 1MB, 1); limit_gb = [math]::Round($total / 1MB, 1) }
}

# Leave when the parent (its PID is the first argument) has gone, so a crashed hub never leaves this running.
$parentPid = if ($args.Count -gt 0) { [int]$args[0] } else { 0 }
function Parent-Alive { if ($parentPid -le 0) { return $true }; try { $p = [System.Diagnostics.Process]::GetProcessById($parentPid); return -not $p.HasExited } catch { return $false } }

$tick = 0
while (Parent-Alive) {
  if ($tick % 2 -eq 0) { try { Emit (Read-Net) } catch { Emit @{ kind = 'error'; sensor = 'net'; why = $_.Exception.Message } } }
  if ($null -ne $np -and $tick % 3 -eq 0) { try { Emit (Read-NowPlaying) } catch { Emit @{ kind = 'np'; status = 'none'; why = $_.Exception.Message } } }
  if ($idleOk -and $tick % 5 -eq 0) { try { Emit @{ kind = 'idle'; s = [math]::Round([TvHub.Idle]::Seconds()) } } catch { Emit @{ kind = 'error'; sensor = 'idle'; why = $_.Exception.Message } } }
  if ($tick % 10 -eq 0) { try { Emit (Read-Commit) } catch { Emit @{ kind = 'error'; sensor = 'commit'; why = $_.Exception.Message } } }
  if ($tick % 60 -eq 0) { try { Emit (Read-Battery) } catch { Emit @{ kind = 'error'; sensor = 'battery'; why = $_.Exception.Message } } }
  $tick++
  Start-Sleep -Milliseconds 1000
}
