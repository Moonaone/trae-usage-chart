[CmdletBinding()]
param(
  [switch]$Install
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'build\node.cmd'
$syntax = Join-Path $root 'build\check-syntax.js'
$selftest = Join-Path $root 'build\selftest.js'
$smoke = Join-Path $root 'build\render-smoke.js'
$pack = Join-Path $root 'build\pack.ps1'

$syntaxOutput = (& $node $syntax 2>&1 | Out-String)
Write-Output $syntaxOutput.TrimEnd()
if ($syntaxOutput -match 'FAIL ') { throw 'Syntax check reported a failure' }

$selftestOutput = (& $node $selftest 2>&1 | Out-String)
Write-Output $selftestOutput.TrimEnd()
if ($selftestOutput -match 'FAIL ') { throw 'Self-test reported a failure' }
if ($selftestOutput -notmatch 'selftest summary: (\d+)/(\d+) passed') { throw 'Self-test summary line missing' }
$passedCount = [int]$Matches[1]
$caseCount = [int]$Matches[2]
if ($passedCount -ne $caseCount -or $caseCount -lt 1) { throw ('Self-test passed ' + $passedCount + '/' + $caseCount) }

$smokeOutput = (& $node $smoke 2>&1 | Out-String)
Write-Output $smokeOutput.TrimEnd()
if ($smokeOutput -notmatch 'RENDER OK') { throw 'Render smoke test failed' }

powershell -NoProfile -ExecutionPolicy Bypass -File $pack
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $Install) {
  Write-Output 'VERIFY PASS (checks and packaging only; pass -Install to copy into TRAE)'
  return
}

$package = Get-Content -LiteralPath (Join-Path $root 'extension\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$folderName = '{0}.{1}-{2}' -f $package.publisher, $package.name, $package.version
$target = Join-Path $env:USERPROFILE ('.trae-cn\extensions\' + $folderName)
if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }

$source = Join-Path $root 'extension'
Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
foreach ($file in @(Get-ChildItem -LiteralPath $target -Recurse -File)) {
  $relative = $file.FullName.Substring($target.Length).TrimStart('\')
  if (-not (Test-Path -LiteralPath (Join-Path $source $relative))) { Remove-Item -LiteralPath $file.FullName -Force }
}

$bad = @()
foreach ($file in @(Get-ChildItem -LiteralPath $source -Recurse -File)) {
  $relative = $file.FullName.Substring($source.Length).TrimStart('\')
  $installed = Join-Path $target $relative
  if (-not (Test-Path -LiteralPath $installed)) { $bad += $relative; continue }
  $a = (Get-FileHash -LiteralPath $file.FullName -Algorithm MD5).Hash
  $b = (Get-FileHash -LiteralPath $installed -Algorithm MD5).Hash
  if ($a -ne $b) { $bad += $relative }
}
if ($bad.Count -gt 0) { throw ('MD5 mismatch: ' + ($bad -join ', ')) }

$installedCount = @(Get-ChildItem -LiteralPath $target -Recurse -File).Count
Write-Output ('VERIFY PASS files=' + @(Get-ChildItem -LiteralPath $source -Recurse -File).Count + ' installed=' + $installedCount + ' md5=OK target=' + $target)
Write-Output 'Reload the window: Ctrl+Shift+P -> Developer: Reload Window'