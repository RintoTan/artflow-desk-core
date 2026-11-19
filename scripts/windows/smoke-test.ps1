# Windows 启动 / 退出冒烟测试（DEV-11）
#
# 只做四件事：启动、等窗口、优雅关闭、确认进程退出；然后重复一次验证"二次启动"。
# 任何清理都只针对本次启动的进程树，不使用全局杀进程。
#
# 输出统一为 `RESULT|<检查项>|<PASS|FAIL|PARTIAL>|<说明>`，方便在 CI 日志里筛。

param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [ValidateSet('Production', 'QA')][string]$Mode = 'Production',
    [string]$Scenario = 'seeded',
    [int]$Cycles = 2,
    [int]$WindowTimeoutSec = 60,
    [int]$ExitTimeoutSec = 25,
    [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AfdWin {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@

$WM_CLOSE = 0x0010
$results = New-Object System.Collections.Generic.List[string]
$failures = 0

function Write-Log {
    param([string]$Line)
    Write-Host $Line
    if ($LogPath) { Add-Content -Path $LogPath -Value $Line -Encoding UTF8 }
}

function Record {
    param([string]$Check, [string]$Status, [string]$Detail)
    $line = "RESULT|$Check|$Status|$Detail"
    $script:results.Add($line) | Out-Null
    if ($Status -eq 'FAIL') { $script:failures++ }
    Write-Log $line
}

function Get-ProcessTree {
    param([int]$RootId)
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Select-Object ProcessId, ParentProcessId
    $ids = New-Object System.Collections.Generic.List[int]
    $ids.Add($RootId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($p in $all) {
            if ($ids -contains [int]$p.ParentProcessId -and -not ($ids -contains [int]$p.ProcessId)) {
                $ids.Add([int]$p.ProcessId)
                $changed = $true
            }
        }
    }
    return $ids
}

function Stop-OwnTree {
    param([int]$RootId)
    # 只结束本次测试启动的进程及其子进程；不动其它 WebView2 进程。
    foreach ($id in (Get-ProcessTree -RootId $RootId)) {
        try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch { }
    }
}

function Wait-MainWindow {
    param([System.Diagnostics.Process]$Proc, [int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($Proc.HasExited) { return $null }
        $Proc.Refresh()
        if ($Proc.MainWindowHandle -ne [IntPtr]::Zero) { return $Proc.MainWindowHandle }
        Start-Sleep -Milliseconds 500
    }
    return [IntPtr]::Zero
}

function Get-DataDir {
    param([string]$Kind, [string]$Sc)
    if ($Kind -eq 'Production') { return (Join-Path $env:APPDATA 'dev.artflow.minidesk') }
    return (Join-Path (Join-Path $env:APPDATA 'dev.artflow.minidesk.qa') $Sc)
}

function Get-LogTail {
    param([string]$Dir)
    $file = Join-Path (Join-Path $Dir 'logs') 'app.log'
    if (Test-Path $file) {
        return (Get-Content $file -Tail 20 -Encoding UTF8) -join "`n"
    }
    return '<无诊断日志>'
}

if (-not (Test-Path $ExePath)) {
    Record 'exe-exists' 'FAIL' "找不到 $ExePath"
    exit 1
}
$exe = (Resolve-Path $ExePath).Path
Record 'exe-exists' 'PASS' $exe

$dataDir = Get-DataDir -Kind $Mode -Sc $Scenario
Write-Log "INFO|mode=$Mode scenario=$Scenario dataDir=$dataDir cycles=$Cycles"

for ($i = 1; $i -le $Cycles; $i++) {
    $tag = "run$i"

    if ($Mode -eq 'QA') { $env:AF_MINIDESK_QA_SCENARIO = $Scenario }
    else { Remove-Item Env:AF_MINIDESK_QA_SCENARIO -ErrorAction SilentlyContinue }

    $proc = Start-Process -FilePath $exe -PassThru -WindowStyle Normal
    Write-Log "INFO|$tag pid=$($proc.Id) started"

    Start-Sleep -Milliseconds 1500
    if ($proc.HasExited) {
        Record "$tag-start" 'FAIL' "启动后立即退出，ExitCode=$($proc.ExitCode)；日志：$(Get-LogTail $dataDir)"
        break
    }

    $hwnd = Wait-MainWindow -Proc $proc -TimeoutSec $WindowTimeoutSec
    if ($hwnd -eq $null) {
        Record "$tag-start" 'FAIL' "进程在等待窗口期间退出；日志：$(Get-LogTail $dataDir)"
        break
    }
    if ($hwnd -eq [IntPtr]::Zero) {
        Record "$tag-window" 'FAIL' "进程存活但 $WindowTimeoutSec 秒内没有主窗口；日志：$(Get-LogTail $dataDir)"
        Stop-OwnTree -RootId $proc.Id
        break
    }

    $proc.Refresh()
    Record "$tag-window" 'PASS' "hwnd=$hwnd title=$($proc.MainWindowTitle)"

    # 优雅关闭：发 WM_CLOSE，走应用自己的关闭流程
    $posted = [AfdWin]::PostMessage($hwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    if (-not $posted) {
        Record "$tag-close-request" 'FAIL' "WM_CLOSE 投递失败"
    }
    else {
        Record "$tag-close-request" 'PASS' 'WM_CLOSE 已投递'
    }

    $exited = $proc.WaitForExit($ExitTimeoutSec * 1000)
    if (-not $exited) {
        $detail = "关闭窗口后 $ExitTimeoutSec 秒内进程未退出（疑似窗口消失但进程残留）；日志：$(Get-LogTail $dataDir)"
        Record "$tag-exit" 'FAIL' $detail
        try {
            Get-Process -Id $proc.Id | Select-Object Id, ProcessName, MainWindowHandle, StartTime |
                Format-List | Out-String | Write-Log
        }
        catch { }
        Stop-OwnTree -RootId $proc.Id
        break
    }

    Record "$tag-exit" 'PASS' "退出码=$($proc.ExitCode)"

    # 退出后不应留下本次启动的子进程
    Start-Sleep -Milliseconds 800
    $left = Get-ProcessTree -RootId $proc.Id | Where-Object { $_ -ne $proc.Id }
    $alive = @()
    foreach ($id in $left) {
        if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $alive += $id }
    }
    if ($alive.Count -gt 0) {
        Record "$tag-children" 'FAIL' "主进程退出后仍有子进程存活：$($alive -join ',')"
        foreach ($id in $alive) { try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch { } }
    }
    else {
        Record "$tag-children" 'PASS' '无残留子进程'
    }
}

# 数据目录与隔离
if (Test-Path $dataDir) {
    Record 'data-dir' 'PASS' "$dataDir 存在"
}
else {
    Record 'data-dir' 'FAIL' "$dataDir 不存在"
}

if ($Mode -eq 'QA') {
    $marker = Join-Path $dataDir '.qa-root'
    if (Test-Path $marker) { Record 'qa-marker' 'PASS' '.qa-root 存在' }
    else { Record 'qa-marker' 'FAIL' '缺少 .qa-root 标记' }

    $prodDir = Join-Path $env:APPDATA 'dev.artflow.minidesk'
    if (Test-Path $prodDir) {
        Record 'isolation' 'FAIL' "QA 运行不应创建正式目录 $prodDir"
    }
    else {
        Record 'isolation' 'PASS' '未创建正式数据目录'
    }
}
else {
    $qaRoot = Join-Path $env:APPDATA 'dev.artflow.minidesk.qa'
    if (Test-Path $qaRoot) {
        Record 'isolation' 'FAIL' "正式版运行不应创建 QA 目录 $qaRoot"
    }
    else {
        Record 'isolation' 'PASS' '未创建 QA 数据目录'
    }
}

$summary = "SUMMARY|$Mode|total=$($results.Count)|failures=$failures"
Write-Log $summary
Write-Log "INFO|dataDir-log $(Get-LogTail $dataDir)"

if ($failures -gt 0) { exit 1 }
exit 0
