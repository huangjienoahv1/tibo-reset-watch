#Requires -Version 7.0
# 为 Pages 控制台生成只包含网页和 Worker 的独立上传包。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path ([IO.Path]::GetTempPath()) ('tibo-pages-' + [guid]::NewGuid().ToString('N'))
$siteRoot = Join-Path $outputRoot 'site'
New-Item -ItemType Directory -Path $siteRoot | Out-Null
$assets = @('index.html', 'app.js', 'post-cards.js', 'config.js', 'sw.js', 'styles.css', 'favicon.svg', 'manifest.webmanifest')
foreach ($asset in $assets) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "web/$asset") -Destination (Join-Path $siteRoot $asset)
}
$esbuild = Join-Path $projectRoot 'node_modules/.bin/esbuild.cmd'
if (-not (Test-Path -LiteralPath $esbuild)) { throw '缺少 Pages 打包工具，请先执行 npm.cmd ci。' }
& $esbuild (Join-Path $projectRoot 'cloudflare/worker.mjs') --bundle --format=esm --platform=browser --target=es2022 "--outfile=$(Join-Path $siteRoot '_worker.js')"
if ($LASTEXITCODE -ne 0) { throw 'Pages Worker 打包失败。' }
foreach ($name in @('_routes.json', '_headers')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "cloudflare/$name") -Destination (Join-Path $siteRoot $name)
}
$zipPath = Join-Path $outputRoot 'tibo-reset-watch-pages.zip'
Compress-Archive -Path (Join-Path $siteRoot '*') -DestinationPath $zipPath
Write-Output "PAGES_DIRECTORY=$siteRoot"
Write-Output "PAGES_ZIP=$zipPath"
