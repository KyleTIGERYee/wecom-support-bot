[CmdletBinding()]
param(
    [string]$Distro = "Ubuntu-24.04",
    [switch]$Resume,
    [switch]$ApproveSystemChanges,
    [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"
# 标准包根目录包含 windows-package.json；本脚本固定位于 <包根>/windows/install.ps1。
$PackageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$StateDir = Join-Path $env:LOCALAPPDATA "WecomSupportBot"
$StatePath = Join-Path $StateDir "install-state.json"
$ManifestPath = Join-Path $PackageRoot "windows-package.json"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "准备 WSL2 系统功能需要管理员授权。请通过 Install-WecomSupportBot.cmd 发起 UAC，或以管理员 PowerShell 运行。"
    }
}

function Invoke-Native {
    param([Parameter(Mandatory=$true)][string]$File, [Parameter(Mandatory=$true)][string[]]$Arguments)
    & $File @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "$File $($Arguments -join ' ') 失败，退出码 $code" }
}

function Get-BootTime {
    return (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString("o")
}

function Save-State([string]$Phase, [bool]$NeedsReboot = $false) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    @{
        format = "wecom-support-bot-install-state"
        phase = $Phase
        distro = $Distro
        packageHash = (Get-FileHash -Algorithm SHA256 $ManifestPath).Hash
        bootTime = Get-BootTime
        needsReboot = $NeedsReboot
    } | ConvertTo-Json | Set-Content -Encoding UTF8 $StatePath
}

function Read-State {
    if (-not (Test-Path $StatePath)) { throw "没有可续装的记录。请不带 -Resume 从安全检查开始。" }
    $state = Get-Content -Raw $StatePath | ConvertFrom-Json
    if ($state.format -ne "wecom-support-bot-install-state") { throw "续装记录格式不受支持。" }
    if ($state.distro -ne $Distro) { throw "续装发行版与记录不一致：$Distro" }
    if ($state.packageHash -ne (Get-FileHash -Algorithm SHA256 $ManifestPath).Hash) { throw "安装资源包已变化，请重新运行完整校验，不能混用续装包。" }
    if ($state.needsReboot -and $state.bootTime -eq (Get-BootTime)) { throw "Windows 尚未重启。请重启后再运行 -Resume；安装器不会代替你重启。" }
    return $state
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw "WSL2 安装需要 64 位 Windows。" }
    if ($Distro -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "发行版名称只能包含字母、数字、点、下划线和连字符。" }
    if (-not (Test-Path $ManifestPath)) { throw "缺少 windows-package.json。请从完整、未拆分的安装资源包运行。" }
    $manifest = Get-Content -Raw $ManifestPath | ConvertFrom-Json
    if ($manifest.format -ne "wecom-support-bot-windows-installer" -or $manifest.formatVersion -ne 1) { throw "安装资源包格式不受支持。" }
    $declared = @{}
    foreach ($entry in $manifest.files) {
        if ($declared.ContainsKey($entry.path)) { throw "安装包清单包含重复路径：$($entry.path)" }
        $declared[$entry.path] = $true
        if ([IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|/)\.\.(/|$)') { throw "安装包清单路径越界：$($entry.path)" }
    }
    $allowed = @{}
    foreach ($entry in $manifest.files) { $allowed[$entry.path] = $true }
    $allowed["windows-package.json"] = $true
    foreach ($file in Get-ChildItem -LiteralPath $PackageRoot -Recurse -File) {
        $relative = $file.FullName.Substring($PackageRoot.Length + 1).Replace('\', '/')
        if (-not $allowed.ContainsKey($relative)) { throw "安装包包含未登记内容：$relative" }
        if ($file.LinkType) { throw "安装包不允许符号链接：$relative" }
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "安装包不允许重解析点：$relative" }
    }
    foreach ($entry in $manifest.files) {
        $path = Join-Path $PackageRoot ($entry.path.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "安装资源缺失：$($entry.path)" }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash -ne $entry.sha256) { throw "安装资源校验失败：$($entry.path)" }
    }
    $plan = Get-Content -Raw (Join-Path $PackageRoot "windows/wsl-plan.json") | ConvertFrom-Json
    foreach ($path in @($plan.paths.projectDir, $plan.paths.instanceDir, $plan.paths.runtimeDir)) {
        if ($path -notmatch '^/' -or $path -match '^/mnt/[a-z](/|$)' -or $path -match '(^|/)\.\.(/|$)') { throw "安装计划包含非 Linux 原生运行路径：$path" }
    }
    if ($PlanOnly) {
        $plan | ConvertTo-Json -Depth 10
        exit 0
    }

    Assert-Administrator
    if (-not $ApproveSystemChanges -and -not $Resume) {
        Write-Host "将请求管理员权限启用 WSL2/虚拟机平台、安装 Ubuntu 与 Linux 依赖。"
        Write-Host "不会重启 Windows，不会停止旧机器人，也不会启用正式 botId。"
        $answer = Read-Host "明确继续请输入 INSTALL-WSL2"
        if ($answer -ne "INSTALL-WSL2") { throw "未确认系统变更，已安全退出。" }
    }
    $state = $null
    if ($Resume) { $state = Read-State }
    $currentBoot = Get-BootTime
    if ($state -and $state.bootTime -ne $currentBoot) {
        $fresh = @(& wsl.exe --list --quiet) | ForEach-Object { $_.Trim([char]0, ' ', "`r", "`n") } | Where-Object { $_ }
        if ($fresh -contains $Distro) { throw "检测到已重启且发行版已存在。为避免重复启用功能或误改既有 WSL，请复核后不带 -Resume 运行；安装器会再次明确确认。" }
    }
    if (-not $Resume -and -not $ApproveSystemChanges) {
        throw "非交互/参数化续装也必须显式传 -ApproveSystemChanges；未确认系统变更，已安全退出。"
    }

    if (-not $state -or $state.phase -eq "features" -or $state.phase -eq "reboot") {
        $rebootNeeded = $false
        foreach ($feature in @("Microsoft-Windows-Subsystem-Linux", "VirtualMachinePlatform")) {
            & dism.exe /online /enable-feature /featurename:$feature /all /norestart
            $code = $LASTEXITCODE
            if ($code -eq 3010) { $rebootNeeded = $true }
            elseif ($code -ne 0) { throw "启用 Windows 功能 $feature 失败，DISM 退出码 $code" }
        }
        if ($rebootNeeded) {
            Save-State "reboot" $true
            Write-Host "Windows 功能已启用，必须重启才能继续。安装器现在安全退出；重启后重新运行并加 -Resume。" -ForegroundColor Yellow
            exit 0
        }
        Save-State "distro"
        $state = $null
    }

    $existing = @(& wsl.exe --list --quiet) | ForEach-Object { $_.Trim([char]0, ' ', "`r", "`n") } | Where-Object { $_ }
    if ($existing -notcontains $Distro) {
        $installArgs = @($plan.wslCommands.installDistro | ForEach-Object { $_.ToString().Replace("Ubuntu-24.04", $Distro) })
        Invoke-Native $installArgs[0] $installArgs[1..($installArgs.Count - 1)]
    }
    foreach ($name in @("update", "setDefaultVersion", "setDistroVersion")) {
        $args = @($plan.wslCommands.$name | ForEach-Object { $_.ToString().Replace("Ubuntu-24.04", $Distro) })
        Invoke-Native $args[0] $args[1..($args.Count - 1)]
    }

    Write-Host "接下来会在该发行版启用 systemd，并通过 wsl --shutdown 关闭所有 WSL 发行版中的当前会话以使其生效。"
    Write-Host "如果这是你正在使用的既有发行版，请先保存其中的其他工作。旧企微机器人不受此操作控制。"
    $shutdown = Read-Host "将执行 wsl --shutdown，关闭所有 WSL 发行版会话。明确继续请输入 RESTART-WSL"
    if ($shutdown -ne "RESTART-WSL") { Save-State "distro"; throw "未确认 WSL 重启，已安全退出；确认后可运行 -Resume。" }
    $wslConf = @'
set -e
touch /etc/wsl.conf
if grep -q '^\[boot\]' /etc/wsl.conf; then
  if grep -q '^systemd=' /etc/wsl.conf; then
    sed -i 's/^systemd=.*/systemd=true/' /etc/wsl.conf
  else
    sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
  fi
else
  printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf
fi
'@
    Invoke-Native "wsl.exe" @("--distribution", $Distro, "--user", "root", "--", "bash", "-c", $wslConf)
    Invoke-Native "wsl.exe" @("--shutdown")

    $archive = Join-Path $env:TEMP ("wecom-support-bot-" + [Guid]::NewGuid().ToString("N") + ".tar.gz")
    $token = (Get-FileHash -Algorithm SHA256 $ManifestPath).Hash.Substring(0, 12)
    $linuxPackage = "/tmp/wecom-support-bot-$token"
    # 压缩包副本必须放在 $linuxPackage 之外：install.sh 会对 $linuxPackage 执行 verify-package，
    # 残留在包目录里的 package.tar.gz 会被判为“安装包包含未登记内容”，导致安装必败。
    $linuxArchiveCopy = "$linuxPackage.tar.gz"
    try {
        Invoke-Native "tar.exe" @("-czf", $archive, "-C", $PackageRoot, ".")
        $archiveForWsl = $archive.Replace('\', '/')
        $linuxArchive = (& wsl.exe --distribution $Distro --user root -- wslpath -a $archiveForWsl).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $linuxArchive) { throw "无法转换安装包路径" }
        Invoke-Native "wsl.exe" @("--distribution", $Distro, "--user", "root", "--", "rm", "-rf", $linuxPackage)
        Invoke-Native "wsl.exe" @("--distribution", $Distro, "--user", "root", "--", "mkdir", "-p", $linuxPackage)
        Invoke-Native "wsl.exe" @("--distribution", $Distro, "--user", "root", "--", "cp", $linuxArchive, $linuxArchiveCopy)
        Invoke-Native "wsl.exe" @("--distribution", $Distro, "--user", "root", "--", "tar", "-xzf", $linuxArchiveCopy, "-C", $linuxPackage)
        # 解包后立即删除压缩包副本：传给 install.sh --bundle 的目录只含清单登记文件。
        Invoke-Native "wsl.exe" @("--distribution", $Distro, "--user", "root", "--", "rm", "-f", $linuxArchiveCopy)
        $installArgs = @($plan.wslCommands.installLinux | ForEach-Object { $_.ToString().Replace("Ubuntu-24.04", $Distro).Replace("<package>", $linuxPackage) })
        Invoke-Native $installArgs[0] $installArgs[1..($installArgs.Count - 1)]
    }
    finally {
        # 成功或失败都清理临时压缩包：Windows 侧副本必定删除；WSL 侧副本（解包失败时可能残留）尽力删除，
        # 清理出错不掩盖原始错误。$linuxPackage 目录内始终不含压缩包。
        try { & wsl.exe --distribution $Distro --user root -- rm -f $linuxArchiveCopy | Out-Null } catch { }
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    Write-Host "WSL2、Linux 原生项目、Node/pi/Python 和 systemd 单元已安装。服务尚未启用。" -ForegroundColor Green
    Write-Host "请运行 WecomSupportBot-Console.cmd，完成模型、本地知识/Skills 与独立测试机器人初始化。"
}
catch {
    Write-Host "安装失败或已安全停止：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "没有启用正式机器人。修复原因后可加 -Resume 续装；续装会重新校验资源包和重启状态。"
    exit 1
}
