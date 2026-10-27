[CmdletBinding()]
param(
  [string]$ProjectRoot
)

# Builds a VSIX without any external reference package.
# The OPC shell ([Content_Types].xml + extension.vsixmanifest) is generated here,
# so a fresh clone can build with nothing but Windows PowerShell 5.1.

$ErrorActionPreference = 'Stop'

$rootFromScript = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = $rootFromScript }

$extensionRoot = Join-Path $ProjectRoot 'extension'
$packageJsonPath = Join-Path $extensionRoot 'package.json'
$buildRoot = Join-Path $ProjectRoot 'build'
$stageRoot = Join-Path $buildRoot 'stage'
$verifyRoot = Join-Path $buildRoot '_verify'
$zipPath = Join-Path $buildRoot 'out.zip'
$verifyZip = Join-Path $buildRoot '_verify.zip'

foreach ($required in @('package.json', 'extension.js', 'store.js', 'collector.js', 'cdp.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $extensionRoot $required) -PathType Leaf)) {
    throw "extension/$required not found"
  }
}

$package = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$identityId = $package.name
$publisher = $package.publisher
$version = $package.version
$displayName = $package.displayName
$engine = $package.engines.vscode
if (-not $identityId -or -not $publisher -or -not $version) { throw 'package.json is missing name / publisher / version' }
if (-not $engine) { $engine = '^1.74.0' }
if (-not $displayName) { $displayName = $identityId }

$vsixPath = Join-Path $ProjectRoot ('{0}-{1}.vsix' -f $identityId, $version)

Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $verifyRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $verifyZip -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

$contentTypesPath = Join-Path $stageRoot '[Content_Types].xml'
$manifestPath = Join-Path $stageRoot 'extension.vsixmanifest'
$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension=".json" ContentType="application/json" />
<Default Extension=".js" ContentType="application/javascript" />
<Default Extension=".css" ContentType="text/css" />
<Default Extension=".html" ContentType="text/html" />
<Default Extension=".md" ContentType="text/markdown" />
<Default Extension=".txt" ContentType="text/plain" />
<Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
'@
Set-Content -LiteralPath $contentTypesPath -Value $contentTypes -Encoding UTF8

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$identityId" Version="$version" Publisher="$publisher" />
    <DisplayName>$displayName</DisplayName>
    <Description xml:space="preserve">Offline usage overview and charts for TRAE CN</Description>
    <Tags>TRAE,token,usage,credits,cache,chart</Tags>
    <Categories>Visualization,Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$engine" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
      <Property Id="Microsoft.VisualStudio.Services.EnableMarketplaceQnA" Value="false" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
  </Assets>
</PackageManifest>
"@
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8

Copy-Item -LiteralPath $extensionRoot -Destination (Join-Path $stageRoot 'extension') -Recurse -Force

Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $zipPath -Force
if (Test-Path -LiteralPath $vsixPath) { Remove-Item -LiteralPath $vsixPath -Force }
Move-Item -LiteralPath $zipPath -Destination $vsixPath -Force

# Self check: reopen the produced package and validate the shell.
New-Item -ItemType Directory -Force -Path $verifyRoot | Out-Null
Copy-Item -LiteralPath $vsixPath -Destination $verifyZip -Force
Expand-Archive -LiteralPath $verifyZip -DestinationPath $verifyRoot -Force
$mustExist = @('[Content_Types].xml', 'extension.vsixmanifest', 'extension\package.json', 'extension\extension.js')
foreach ($relative in $mustExist) {
  if (-not (Test-Path -LiteralPath (Join-Path $verifyRoot $relative))) {
    throw "VSIX verification failed; missing $relative"
  }
}
foreach ($xml in @('[Content_Types].xml', 'extension.vsixmanifest')) {
  $path = Join-Path $verifyRoot $xml
  try { [void]([xml](Get-Content -LiteralPath $path -Raw -Encoding UTF8)) }
  catch { throw "VSIX verification failed; $xml is not valid XML" }
}
$checkManifest = [xml](Get-Content -LiteralPath (Join-Path $verifyRoot 'extension.vsixmanifest') -Raw -Encoding UTF8)
$ns = New-Object System.Xml.XmlNamespaceManager($checkManifest.NameTable)
$ns.AddNamespace('d', 'http://schemas.microsoft.com/developer/vsx-schema/2011')
$identity = $checkManifest.SelectSingleNode('//d:Identity', $ns)
if ($null -eq $identity) { throw 'VSIX verification failed; Identity missing' }
if ($identity.GetAttribute('Id') -ne $identityId) { throw 'VSIX verification failed; Id mismatch' }
if ($identity.GetAttribute('Version') -ne $version) { throw 'VSIX verification failed; Version mismatch' }

Remove-Item -LiteralPath $verifyRoot -Recurse -Force
Remove-Item -LiteralPath $verifyZip -Force

Write-Output ("Created {0} ({1} {2}.{3})" -f $vsixPath, $identityId, $publisher, $version)