[CmdletBinding()]
param(
    [string]$Distro = "Ubuntu-24.04",
    [ValidateSet("menu", "init", "status", "sync", "ask", "configure-test", "configure-production", "start", "stop", "restart", "service-status", "acceptance-create", "acceptance-update", "acceptance-run", "acceptance-compare", "cutover-new", "rollback-new")]
    [string]$Command = "menu",
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$Project = "/opt/wecom-support-bot/app"
$Instance = "/var/lib/wecom-support-bot/instance"
$Runtime = "/opt/wecom-support-bot/runtime"
$PiBinary = "$Runtime/pi/bin/pi"

function Invoke-Wsl {
    param([string]$User = "wecom", [Parameter(Mandatory=$true)][string[]]$CommandLine)
    # 控制台、初始化检查与后续 Node 子进程统一使用安装器创建的隔离 pi。
    & wsl.exe --distribution $Distro --user $User -- env "WECOM_BOT_PI_BINARY=$PiBinary" @CommandLine
    if ($LASTEXITCODE -ne 0) { throw "WSL 操作失败（退出码 $LASTEXITCODE）。请查看上方具体错误；控制台不会把失败写成成功。" }
}

function Invoke-Node {
    param([string]$User = "wecom", [Parameter(Mandatory=$true)][string]$Script, [Parameter(Mandatory=$true)][string[]]$CliArgs)
    Invoke-Wsl $User (@("$Runtime/node/bin/node", "$Project/scripts/$Script") + $CliArgs)
}

function Assert-AllowedWslDataPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not $Path.StartsWith("/") -or $Path.Contains('\') -or $Path.Contains("`n") -or $Path.Contains("`r")) {
        throw "WSL 数据路径无效：$Path"
    }
    if ($Path.Split("/") -contains "..") { throw "WSL 数据路径不能包含 ..：$Path" }
    $allowed = ($Path -match '^/mnt/[a-z](/|$)') -or
        ($Path -match '^/tmp(/|$)') -or
        ($Path -match '^/var/lib/wecom-support-bot(/|$)') -or
        ($Path -match '^/opt/wecom-support-bot(/|$)') -or
        ($Path -match '^/home/wecom(/|$)')
    if (-not $allowed) { throw "数据路径必须位于 Windows 挂载盘、/tmp 或本实例允许的 Linux 数据目录：$Path" }
}

function ConvertTo-WslPath([string]$Path) {
    if ($Path.StartsWith("/")) {
        Assert-AllowedWslDataPath $Path
        return $Path
    }
    if ($Path -match '^[A-Za-z]:[\\/]') { $pathForWsl = $Path.Replace('\', '/') }
    else {
        $full = [IO.Path]::GetFullPath($Path)
        $pathForWsl = $full.Replace('\', '/')
    }
    $converted = (& wsl.exe --distribution $Distro --user wecom -- wslpath -a $pathForWsl).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $converted) { throw "无法把来源路径转换为 WSL 路径：$Path" }
    Assert-AllowedWslDataPath $converted
    return $converted
}

function Convert-EvidencePaths([string[]]$Provided) {
    $result = [string[]]$Provided.Clone()
    $pathFlags = @("--acceptance", "--record", "--evidence", "--questions", "--output", "--before", "--after", "--old-stopped", "--snapshot", "--windows-stopped")
    for ($i = 0; $i -lt $result.Count; $i++) {
        if ($pathFlags -notcontains $result[$i]) { continue }
        if ($i + 1 -ge $result.Count -or [string]::IsNullOrWhiteSpace($result[$i + 1]) -or $result[$i + 1].StartsWith("--")) { throw "$($result[$i]) 缺少证据、记录或状态包路径" }
        $result[$i + 1] = ConvertTo-WslPath $result[$i + 1]
    }
    return $result
}

function Convert-SourcePath([string]$Path) {
    if ($Path -match '^[A-Za-z][A-Za-z0-9+.-]*://' -or $Path -match '^[^/\s@]+@[^/\s:]+:.+') { return $Path }
    return ConvertTo-WslPath $Path
}

function Assert-ModelUrl([string]$Url) {
    Invoke-Node "wecom" "windows-instance.js" @("validate-model-url", "--url", $Url)
}

function Read-Secret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Initialize-Instance([string[]]$Provided) {
    if ($Provided.Count -gt 0) {
        for ($i = 0; $i -lt $Provided.Count; $i++) {
            if ($Provided[$i] -match '^--([a-z]+-)?base-url$') { Assert-ModelUrl $Provided[$i + 1] }
            if ($Provided[$i] -eq "--source") { $Provided[$i + 1] = Convert-SourcePath $Provided[$i + 1] }
            if ($Provided[$i] -eq "--package") { $Provided[$i + 1] = ConvertTo-WslPath $Provided[$i + 1] }
        }
        Invoke-Node "wecom" "local-instance.js" (@("init", "--instance-dir", $Instance) + $Provided)
        return
    }
    $template = Read-Host "模板 team/blank/import（默认 team）"
    if (-not $template) { $template = "team" }
    $cli = @("init", "--instance-dir", $Instance, "--template", $template)
    if ($template -eq "import") {
        $package = Read-Host "06 团队资源包路径"
        $cli += @("--package", (ConvertTo-WslPath $package))
    }
    else {
        $source = Read-Host "本地知识/Skills 目录、文件或 zip（会复制到 Linux 原生实例）"
        if ($source) {
            $scope = if ($template -eq "team") { "shared" } else { Read-Host "范围 shared/private" }
            $cli += @("--source", (ConvertTo-WslPath $source), "--scope", $scope)
        }
    }
    $baseUrl = Read-Host "主模型 URL（不能沿用原机器 localhost；将从 WSL 内真实测试）"
    Assert-ModelUrl $baseUrl
    $apiKey = Read-Secret "模型 API Key"
    $model = Read-Host "主模型名称"
    $cli += @("--base-url", $baseUrl, "--api-key", $apiKey, "--model", $model)
    Invoke-Node "wecom" "local-instance.js" $cli
}

function Sync-Instance([string[]]$Provided) {
    if ($Provided.Count -eq 0) {
        $source = Read-Host "同步来源目录、文件或 zip"
        $scope = Read-Host "范围 shared/private（团队实例只能 shared）"
        $Provided = @("--source", $source, "--scope", $scope)
    }
    for ($i = 0; $i -lt $Provided.Count; $i++) {
        if ($Provided[$i] -eq "--source") { $Provided[$i + 1] = Convert-SourcePath $Provided[$i + 1] }
    }
    Invoke-Node "wecom" "local-instance.js" (@("sync", "--instance-dir", $Instance) + $Provided)
    Write-Host "同步完成。若没有正在处理的问题，请通过控制台“重启服务”加载新资源目录；控制台不会静默重启。"
}

function Configure-Channel([string]$Kind, [string[]]$Provided) {
    if ($Provided.Count -eq 0) {
        $botId = Read-Host "$Kind 机器人 botId"
        $secret = Read-Secret "$Kind 机器人 secret"
        $Provided = @("--bot-id", $botId, "--secret", $secret)
    }
    Invoke-Node "wecom" "windows-instance.js" (@("configure-channel", "--instance-dir", $Instance, "--kind", $Kind) + $Provided)
    if ($Kind -eq "production") { Write-Host "正式凭证只保存，未启用。正式启用只能走 cutover-new 安全门。" }
}

function Show-Menu {
    Clear-Host
    Write-Host "企微技术支持机器人 · Windows 本地控制台"
    Write-Host "实例位于 Linux 原生文件系统；模型检查在 WSL 内执行。"
    Write-Host "1 初始化/重新初始化   2 资源状态   3 同步资源   4 本地提问"
    Write-Host "5 配置测试机器人     6 保存正式机器人（不启用）"
    Write-Host "7 启动测试服务       8 停止服务   9 重启服务   10 服务状态"
    Write-Host "11 创建验收记录      12 登记验收证据   0 退出"
    $choice = Read-Host "选择"
    switch ($choice) {
        "1" { Initialize-Instance @() }
        "2" { Invoke-Node "wecom" "local-instance.js" @("status", "--instance-dir", $Instance) }
        "3" { Sync-Instance @() }
        "4" { $q = Read-Host "问题"; Invoke-Node "wecom" "local-instance.js" @("ask", "--instance-dir", $Instance, "--question", $q, "--session-key", "windows-console") }
        "5" { Configure-Channel "test" @() }
        "6" { Configure-Channel "production" @() }
        "7" { Invoke-Wsl "root" @("bash", "$Project/windows/linux/service.sh", "start") }
        "8" { Invoke-Wsl "root" @("bash", "$Project/windows/linux/service.sh", "stop") }
        "9" { Invoke-Wsl "root" @("bash", "$Project/windows/linux/service.sh", "restart") }
        "10" { Invoke-Wsl "root" @("bash", "$Project/windows/linux/service.sh", "status") }
        "11" { $path = Read-Host "验收记录输出路径"; $cli = @("acceptance-create", "--instance-dir", $Instance, "--output", $path); Invoke-Node "wecom" "windows-instance.js" @(Convert-EvidencePaths $cli) }
        "12" { $r = Read-Host "验收记录路径"; $c = Read-Host "验收项 ID"; $s = Read-Host "passed/failed/pending"; $e = Read-Host "证据或对照结果路径"; $cli = @("acceptance-update", "--record", $r, "--case", $c, "--status", $s, "--evidence", $e); Invoke-Node "wecom" "windows-instance.js" @(Convert-EvidencePaths $cli) }
        "0" { return }
        default { Write-Host "未知选择" }
    }
}

try {
    if ($Distro -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "发行版名称无效" }
    switch ($Command) {
        "menu" { Show-Menu }
        "init" { Initialize-Instance $Arguments }
        "status" { Invoke-Node "wecom" "local-instance.js" @("status", "--instance-dir", $Instance) }
        "sync" { Sync-Instance $Arguments }
        "ask" { Invoke-Node "wecom" "local-instance.js" (@("ask", "--instance-dir", $Instance) + $Arguments) }
        "configure-test" { Configure-Channel "test" $Arguments }
        "configure-production" { Configure-Channel "production" $Arguments }
        "start" { Invoke-Wsl "root" @("bash", "$Project/windows/linux/service.sh", "start") }
        "stop" { Invoke-Wsl "root" @("bash", "$Project/windows/linux/service.sh", "stop") }
        "restart" { Invoke-Wsl "root" @("bash", "$Project/windows/linux/service.sh", "restart") }
        "service-status" { Invoke-Wsl "root" @("bash", "$Project/windows/linux/service.sh", "status") }
        "acceptance-create" { Invoke-Node "wecom" "windows-instance.js" (@("acceptance-create", "--instance-dir", $Instance) + @(Convert-EvidencePaths $Arguments)) }
        "acceptance-update" { Invoke-Node "wecom" "windows-instance.js" (@("acceptance-update") + @(Convert-EvidencePaths $Arguments)) }
        "acceptance-run" { Invoke-Node "wecom" "windows-instance.js" (@("acceptance-run", "--instance-dir", $Instance) + @(Convert-EvidencePaths $Arguments)) }
        "acceptance-compare" { Invoke-Node "wecom" "windows-instance.js" (@("acceptance-compare") + @(Convert-EvidencePaths $Arguments)) }
        "cutover-new" { Invoke-Wsl "root" (@("$Runtime/node/bin/node", "$Project/scripts/windows-instance.js", "cutover-new", "--instance-dir", $Instance, "--linux-user", "wecom") + @(Convert-EvidencePaths $Arguments)) }
        "rollback-new" { Invoke-Wsl "root" (@("$Runtime/node/bin/node", "$Project/scripts/windows-instance.js", "rollback-new", "--instance-dir", $Instance) + @(Convert-EvidencePaths $Arguments)) }
    }
}
catch {
    Write-Host "控制台操作失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
