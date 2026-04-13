# UnityChat Auto-Sync (webhook-driven)
#
# GitHub push → webhook → VPS git pull + touch signal file
# This script watches the signal file via SSH + inotifywait.
# When signal fires → local git pull from GitHub.
#
# Start: powershell -File "D:\_BACKUP_2.0\Code Projects\UnityChat\scripts\auto-sync.ps1"
# Background: Start-Process powershell -ArgumentList '-WindowStyle Hidden -File "D:\_BACKUP_2.0\Code Projects\UnityChat\scripts\auto-sync.ps1"' -WindowStyle Hidden

$repo = "D:\_BACKUP_2.0\Code Projects\UnityChat"
$vps = "root@178.104.160.182"
$signal = "/tmp/uc-deploy-signal"

Set-Location $repo

Write-Host "UnityChat auto-sync (webhook-driven)" -ForegroundColor Cyan
Write-Host "Watching VPS signal file via SSH + inotifywait" -ForegroundColor DarkGray
Write-Host "Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host ""

while ($true) {
    try {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Waiting for deploy webhook..." -ForegroundColor DarkGray

        # Block until signal file is touched (webhook fires after git pull on VPS)
        ssh -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
            $vps "inotifywait -qq -e modify -e create -e attrib $signal 2>/dev/null" 2>$null

        if ($LASTEXITCODE -ne 0) {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] SSH disconnected, reconnecting in 5s..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
            continue
        }

        # Small delay to ensure GitHub has the data
        Start-Sleep -Seconds 2

        # Pull current branch
        $branch = git rev-parse --abbrev-ref HEAD 2>$null
        if (-not $branch) { $branch = "dev" }

        git pull origin $branch --ff-only --quiet 2>$null

        if ($LASTEXITCODE -eq 0) {
            $msg = git log --oneline -1
            $time = Get-Date -Format "HH:mm:ss"
            Write-Host "[$time] Synced: $msg" -ForegroundColor Green

            # Windows toast notification
            try {
                Add-Type -AssemblyName System.Windows.Forms
                $balloon = New-Object System.Windows.Forms.NotifyIcon
                $balloon.Icon = [System.Drawing.SystemIcons]::Information
                $balloon.BalloonTipTitle = "UnityChat synced"
                $balloon.BalloonTipText = $msg
                $balloon.Visible = $true
                $balloon.ShowBalloonTip(3000)
                Start-Sleep -Seconds 4
                $balloon.Dispose()
            } catch {}
        } else {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Pull failed" -ForegroundColor Red
        }
    } catch {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Error: $_" -ForegroundColor Red
        Start-Sleep -Seconds 5
    }
}
