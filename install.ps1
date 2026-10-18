<#
.SYNOPSIS
  Installs the dsh-rustvy plugin into a DeepSeek Harness profile.

.DESCRIPTION
  Copies this package into <profile>\node_modules\dsh-rustvy as a REAL
  directory (never a symlink or junction: the harness only hands the
  application's own packages to a profile plugin that lives at a real path),
  then appends the package to dsh.profile.bundles in <profile>\package.json.

  The bundle's own cordis.patch.yml supplies the loader row, which names this
  package by its bare name. That is what lets the plugin manager read the
  package's `locale/*.json` and show the row as "Rustvy" instead of as a file
  path; the row's entry is a stable bootstrap that reloads the implementation
  itself whenever the files on disk change.

  The browser half needs no build step: `client/client.js` is a hand-authored
  bundle in the loader's factory-CJS protocol, and the module system serves it as
  this package's `./client` export.

.PARAMETER ProfileDir
  The profile to install into. Defaults to $env:DSH_PROFILE_DIR, else
  $env:DSH_HOME\profiles\desktop.

.EXAMPLE
  pwsh -File .\install.ps1
  pwsh -File .\install.ps1 -ProfileDir 'C:\Users\me\.dsh\profiles\desktop'
#>
[CmdletBinding()]
param([string]$ProfileDir)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$packageName = 'dsh-rustvy'

if (-not $ProfileDir -or $ProfileDir -eq '') {
    $ProfileDir = if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR }
        elseif ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'profiles\desktop' }
        else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
}

if (-not (Test-Path $ProfileDir)) { throw "profile directory not found: $ProfileDir" }
$manifest = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $manifest)) { throw "profile manifest not found: $manifest" }

# 1. The package itself, as a real directory.
$target = Join-Path $ProfileDir "node_modules\$packageName"
Write-Host "installing $packageName -> $target"
New-Item -ItemType Directory -Force -Path (Join-Path $ProfileDir 'node_modules') | Out-Null
if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType) { throw "$target is a $($item.LinkType); remove it and re-run so it can be a real directory" }
    Remove-Item $target -Recurse -Force
}
# `lib/index.js` is the loader entry the bare package name resolves to: a stable
# bootstrap that imports the implementation through a cache-busting `?rev=` query
# and imports it again whenever the files on disk change. Nothing else needs
# regenerating, so the package is copied as it stands.
Copy-Item $source $target -Recurse -Force

# 2. The bundle row source: this name in dsh.profile.bundles.
$script = @'
const fs = require('fs');
const [file, name] = process.argv.slice(2);
// Tolerate a byte-order mark: an editor or PowerShell 5.1 Set-Content can add
// one, and JSON.parse rejects it.
const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
const bundles = manifest.dsh.profile.bundles ??= [];
if (bundles.includes(name)) {
    console.log(`already listed in dsh.profile.bundles: ${name}`);
} else {
    bundles.push(name);
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`added to dsh.profile.bundles: ${name}`);
}
'@
$script | node --input-type=commonjs - $manifest $packageName
if ($LASTEXITCODE -ne 0) { throw 'could not update the profile manifest' }

Write-Host ''
Write-Host 'Installed. Next:'
Write-Host '  1. Reload the profile. A running harness picks the row up from the'
Write-Host '     manifest change (no restart needed for the plugin itself); the open'
Write-Host '     page follows through the HMR transport, and a plain refresh works too.'
Write-Host '  2. Open the model menu: each row now carries its vendor mark, and so does'
Write-Host '     the composer button of the model that is selected.'
Write-Host '  3. Settings -> Rustvy shows what the mirror holds, what the provider serves,'
Write-Host '     and the drift between the two; it writes the route''s model list on request.'
