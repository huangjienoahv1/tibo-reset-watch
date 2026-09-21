#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9.-]+$')]
    [string]$ServerAddress = '39.98.37.208',

    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$ServerUser = 'root',

    [ValidateRange(1, 65535)]
    [int]$SshPort = 22,

    [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh/id_ed25519_codex_39_98_37_208'),

    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$deployFiles = @(
    'package.json'
    'server/web-server.cjs'
    'web/app.js'
    'web/config.js'
    'web/favicon.svg'
    'web/index.html'
    'web/manifest.webmanifest'
    'web/post-cards.js'
    'web/styles.css'
    'web/sw.js'
)

function Invoke-CheckedNativeCommand {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,

        [Parameter(Mandatory)]
        [string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "命令执行失败（退出码 $LASTEXITCODE）：$FilePath"
    }
}

foreach ($commandName in @('git.exe', 'node.exe', 'npm.cmd', 'ssh.exe', 'scp.exe', 'tar.exe')) {
    if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        throw "缺少部署所需命令：$commandName"
    }
}

if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
    throw "未找到 208 免密登录私钥：$IdentityFile"
}

foreach ($relativePath in $deployFiles) {
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "缺少部署文件：$relativePath"
    }
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ('tibo-reset-watch-deploy-' + [guid]::NewGuid().ToString('N'))
$resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
if (-not $resolvedTempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or
    -not (Split-Path $resolvedTempRoot -Leaf).StartsWith('tibo-reset-watch-deploy-', [StringComparison]::Ordinal)) {
    throw "临时目录校验失败：$resolvedTempRoot"
}

New-Item -ItemType Directory -Path $resolvedTempRoot | Out-Null

try {
    Push-Location $projectRoot
    try {
        Write-Host '1/6 执行本地语法和差异检查...'
        Invoke-CheckedNativeCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'web:check')
        Invoke-CheckedNativeCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'translation:check')
        Invoke-CheckedNativeCommand -FilePath 'git.exe' -ArgumentList @('diff', '--check')

        $commitId = (& git.exe rev-parse --short=8 HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $commitId) {
            throw '无法读取当前 Git 提交号。'
        }
        $dirtySuffix = if (& git.exe status --porcelain) { '-dirty' } else { '' }
        $releaseName = '{0}-{1}{2}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $commitId, $dirtySuffix

        $archivePath = Join-Path $resolvedTempRoot "$releaseName.tar.gz"
        $manifestPath = Join-Path $resolvedTempRoot "$releaseName.sha256"
        $remoteScriptPath = Join-Path $resolvedTempRoot "$releaseName-deploy.sh"

        Write-Host "2/6 打包发布版本 $releaseName..."
        Invoke-CheckedNativeCommand -FilePath 'tar.exe' -ArgumentList (@('-czf', $archivePath, '--') + $deployFiles)

        $manifestLines = foreach ($relativePath in $deployFiles) {
            $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $projectRoot $relativePath)).Hash.ToLowerInvariant()
            "$hash  $relativePath"
        }
        # Linux 的 sha256sum 会把 CR 当作文件名的一部分，发布清单必须显式使用 LF。
        [IO.File]::WriteAllText($manifestPath, (($manifestLines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
        $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()

        $remoteScript = @'
#!/usr/bin/env bash
set -Eeuo pipefail

release=${1:?missing release name}
expected_archive_hash=${2:?missing archive hash}
base=/data/tibo-reset-watch
service=tibo-reset-watch.service
archive="/tmp/$release.tar.gz"
manifest="/tmp/$release.sha256"
script_path="/tmp/$release-deploy.sh"
new_release="$base/releases/$release"
next_link="$base/.current-$release"
rollback_link="$base/.rollback-$release"
new_release_created=0
switched=0

case "$release" in
    ''|*[!A-Za-z0-9._-]*)
        echo "Invalid release name: $release" >&2
        exit 2
        ;;
esac

if [[ ! "$expected_archive_hash" =~ ^[0-9a-f]{64}$ ]]; then
    echo 'Invalid archive hash.' >&2
    exit 2
fi

cleanup_uploads() {
    rm -f -- "$archive" "$manifest" "$script_path" "$next_link" "$rollback_link"
}

rollback_release() {
    echo "Health check failed; rolling back to $old_release" >&2
    ln -s -- "$old_release" "$rollback_link"
    mv -Tf -- "$rollback_link" "$base/current"
    systemctl restart "$service" || true
    for _ in $(seq 1 15); do
        if curl -fsS --max-time 3 "http://127.0.0.1:$service_port/api/translation-status" >/dev/null; then
            echo "Rollback completed: $old_release" >&2
            return 0
        fi
        sleep 1
    done
    echo 'Rollback link was restored, but the previous release health check also failed.' >&2
    return 1
}

on_error() {
    exit_code=$?
    trap - ERR
    if [[ "$switched" == 1 ]]; then
        rollback_release || true
    fi
    if [[ "$new_release_created" == 1 && "$new_release" == "$base/releases/"* ]]; then
        rm -rf -- "$new_release"
    fi
    cleanup_uploads
    exit "$exit_code"
}
trap on_error ERR

test -x "$base/runtime/current/bin/node"
test -f "$base/translation.env"
test -L "$base/current"
systemctl cat "$service" >/dev/null

old_release=$(readlink -f "$base/current")
case "$old_release" in
    "$base/releases/"*) ;;
    *)
        echo "Refusing unexpected current target: $old_release" >&2
        exit 3
        ;;
esac
test -d "$old_release"
test ! -e "$new_release"
test "$(sha256sum "$archive" | awk '{print $1}')" = "$expected_archive_hash"

service_port=$(awk -F= '$1 == "PORT" {value=$2} END {gsub(/\r/, "", value); print value}' "$base/translation.env")
service_port=${service_port:-8788}
if [[ ! "$service_port" =~ ^[0-9]+$ ]] || (( service_port < 1 || service_port > 65535 )); then
    echo "Invalid PORT in $base/translation.env" >&2
    exit 3
fi

mkdir -- "$new_release"
new_release_created=1
tar -xzf "$archive" -C "$new_release"
(
    cd "$new_release"
    sha256sum -c "$manifest"
)

expected_file_count=$(wc -l < "$manifest")
actual_file_count=$(find "$new_release" -type f | wc -l)
test "$actual_file_count" -eq "$expected_file_count"

node_bin="$base/runtime/current/bin/node"
"$node_bin" --check "$new_release/server/web-server.cjs"
"$node_bin" --check "$new_release/web/config.js"
"$node_bin" --check "$new_release/web/app.js"
"$node_bin" --check "$new_release/web/post-cards.js"
"$node_bin" --check "$new_release/web/sw.js"

ln -s -- "$new_release" "$next_link"
mv -Tf -- "$next_link" "$base/current"
switched=1
systemctl restart "$service"

ready=0
for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$service_port/api/translation-status" >/dev/null; then
        ready=1
        break
    fi
    sleep 1
done
test "$ready" -eq 1
test "$(readlink -f "$base/current")" = "$new_release"
test "$(systemctl is-active "$service")" = active

switched=0
new_release_created=0
trap - ERR
cleanup_uploads

echo "PREVIOUS_RELEASE=$old_release"
echo "CURRENT_RELEASE=$new_release"
echo "DEPLOY_PORT=$service_port"
systemctl show "$service" -p ActiveState -p SubState -p NRestarts
'@
        [IO.File]::WriteAllText($remoteScriptPath, ($remoteScript -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false))

        if ($ValidateOnly) {
            $bashCommand = Get-Command 'bash.exe' -ErrorAction SilentlyContinue
            if ($bashCommand) {
                Invoke-CheckedNativeCommand -FilePath $bashCommand.Source -ArgumentList @('-n', $remoteScriptPath)
                Write-Host '远程 Bash 部署脚本语法检查通过。'
            }
            else {
                Write-Warning '本机未找到 bash.exe，已跳过远程 Bash 部署脚本语法检查。'
            }
            Write-Host "本地校验和打包检查通过：$releaseName"
            return
        }

        $target = "$ServerUser@$ServerAddress"
        $sshOptions = @(
            '-i', $IdentityFile,
            '-p', $SshPort.ToString(),
            '-o', 'BatchMode=yes',
            '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-o', 'ConnectTimeout=10'
        )
        $scpOptions = @(
            '-i', $IdentityFile,
            '-P', $SshPort.ToString(),
            '-o', 'BatchMode=yes',
            '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-o', 'ConnectTimeout=10'
        )

        Write-Host '3/6 验证 208 免密连接...'
        Invoke-CheckedNativeCommand -FilePath 'ssh.exe' -ArgumentList ($sshOptions + @($target, 'true'))

        Write-Host '4/6 上传发布包和校验清单...'
        Invoke-CheckedNativeCommand -FilePath 'scp.exe' -ArgumentList ($scpOptions + @(
            $archivePath,
            $manifestPath,
            $remoteScriptPath,
            "${target}:/tmp/"
        ))

        Write-Host '5/6 切换版本并执行服务器健康检查...'
        $remoteCommand = "bash '/tmp/$releaseName-deploy.sh' '$releaseName' '$archiveHash'"
        $remoteOutput = & ssh.exe @sshOptions $target $remoteCommand 2>&1
        $remoteExitCode = $LASTEXITCODE
        $remoteOutput | ForEach-Object { Write-Host $_ }
        if ($remoteExitCode -ne 0) {
            throw "服务器部署失败（退出码 $remoteExitCode）；脚本已尝试自动回滚。"
        }

        $portLine = $remoteOutput | Where-Object { $_ -match '^DEPLOY_PORT=([0-9]+)$' } | Select-Object -Last 1
        if (-not $portLine) {
            throw '服务器部署已执行，但没有返回服务端口，无法继续公网检查。'
        }
        $deployedPort = [int](($portLine -split '=', 2)[1])

        Write-Host '6/6 检查公网访问...'
        $publicUrl = "http://${ServerAddress}:$deployedPort/"
        try {
            $statusResponse = Invoke-WebRequest -Uri ($publicUrl + 'api/translation-status') -TimeoutSec 15
            if ($statusResponse.StatusCode -ne 200) {
                throw "HTTP $($statusResponse.StatusCode)"
            }
            Write-Host "公网检查通过：$publicUrl"
        }
        catch {
            Write-Warning "服务器本机健康检查已通过，但公网检查失败：$($_.Exception.Message)"
            Write-Warning "请检查安全组后访问：$publicUrl"
        }

        Write-Host "部署完成：$releaseName"
    }
    finally {
        Pop-Location
    }
}
finally {
    if (Test-Path -LiteralPath $resolvedTempRoot) {
        Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
    }
}
