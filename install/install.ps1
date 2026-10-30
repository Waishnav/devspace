# DevSpace installer for Windows.
#
#   powershell -c "irm https://raw.githubusercontent.com/Waishnav/devspace/main/install/install.ps1 | iex"
#
# Mirrors install.sh: uses a compatible Node already on PATH, otherwise downloads a checksum-verified Node 24 LTS
# for DevSpace alone, installs @waishnav/devspace into a user-owned npm prefix, writes `devspace` launchers that
# pin that Node, then runs `devspace init`. Rerun it to update. DevSpace itself also needs Git Bash on Windows.
#
# Environment overrides: DEVSPACE_VERSION (default: beta), DEVSPACE_INSTALL_DIR, DEVSPACE_BIN_DIR, DEVSPACE_NO_INIT=1,
# DEVSPACE_NO_MODIFY_PATH=1, DEVSPACE_PACKAGE_SPEC (see install.sh).

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Package = "@waishnav/devspace"
# v1.1 is the first release installable without install scripts, and it is still on the beta tag.
# Switch this to latest once v1.1 ships as stable.
$Version = if ($env:DEVSPACE_VERSION) { $env:DEVSPACE_VERSION } else { "beta" }
$PackageSpec = if ($env:DEVSPACE_PACKAGE_SPEC) { $env:DEVSPACE_PACKAGE_SPEC } else { "$Package@$Version" }
$InstallDir = if ($env:DEVSPACE_INSTALL_DIR) { $env:DEVSPACE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "devspace\install" }
$BinDir = if ($env:DEVSPACE_BIN_DIR) { $env:DEVSPACE_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "devspace\bin" }
$NodeMajor = 24
# Must match package.json engines.node.
$NodeMin = "22.19.0"
$NodeMaxMajor = 27

function Test-CompatibleNode([string]$Node) {
  $script = 'const [maj,min,patch]=process.versions.node.split(".").map(Number);const [a,b,c]=process.argv[1].split(".").map(Number);const ok=maj>a||(maj===a&&(min>b||(min===b&&patch>=c)));process.exit(ok&&maj<Number(process.argv[2])?0:1)'
  & $Node -e $script $NodeMin $NodeMaxMajor *> $null
  return $LASTEXITCODE -eq 0
}

function Install-Node {
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default { throw "Unsupported CPU architecture: $($env:PROCESSOR_ARCHITECTURE)" }
  }
  $dist = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("devspace-node-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null

  try {
    Write-Host "Downloading Node $NodeMajor LTS for win-$arch..."
    $sums = (Invoke-WebRequest -UseBasicParsing "$dist/SHASUMS256.txt").Content -split "`n"
    $line = $sums | Where-Object { $_ -match "\s(node-v[\d.]+-win-$arch\.zip)$" } | Select-Object -First 1
    if (-not $line) { throw "No Node $NodeMajor build is published for win-$arch." }
    $expected, $file = $line.Trim() -split "\s+"
    $zip = Join-Path $tmp $file
    Invoke-WebRequest -UseBasicParsing "$dist/$file" -OutFile $zip
    if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne $expected) {
      throw "Checksum mismatch for $file; refusing to install it."
    }

    Expand-Archive -Path $zip -DestinationPath $tmp
    $nodeDir = Join-Path $InstallDir "node"
    if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Move-Item (Join-Path $tmp ($file -replace "\.zip$", "")) $nodeDir
    Write-Host "Installed $($file -replace '\.zip$', '') into $nodeDir"
    return (Join-Path $nodeDir "node.exe")
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

function Select-Node {
  $managed = Join-Path $InstallDir "node\node.exe"
  if ((Test-Path $managed) -and (Test-CompatibleNode $managed)) { return $managed }

  $system = Get-Command node -ErrorAction SilentlyContinue
  if ($system -and (Test-CompatibleNode $system.Source)) {
    # A Volta shim re-resolves on every run, so pin the Node behind it; anything else stays as found.
    if ($system.Source -match "\\Volta\\") { return (& $system.Source -p "process.execPath") }
    return $system.Source
  }
  if ($system) { Write-Host "Found Node $(& $system.Source --version), but DevSpace needs >=$NodeMin <$NodeMaxMajor." }

  return Install-Node
}

# cmd.exe reads .cmd files in the console code page, so a launcher cannot embed non-ASCII text literally.
# Spell paths under the user's profile folders through their environment variables instead, which cmd expands
# with full Unicode, and keep any literal % from being expanded.
function ConvertTo-CmdPath([string]$Path) {
  $prefix = ""
  $rest = $Path
  foreach ($name in @("LOCALAPPDATA", "APPDATA", "USERPROFILE")) {
    $root = [Environment]::GetEnvironmentVariable($name)
    if ($root -and $Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      $prefix = "%$name%"
      $rest = $Path.Substring($root.Length)
      break
    }
  }
  if ($rest -match "[^\x00-\x7F]") {
    throw "Cannot write a launcher for $Path because cmd.exe cannot read its non-ASCII characters. If it is a Node runtime, move that Node to an ASCII path or remove it from PATH so the installer downloads its own; otherwise set DEVSPACE_INSTALL_DIR and DEVSPACE_BIN_DIR to ASCII paths. Then rerun."
  }
  return $prefix + $rest.Replace("%", "%%")
}

$Node = Select-Node
$NodeDir = Split-Path $Node
$Npm = Join-Path $NodeDir "npm.cmd"
if (-not (Test-Path $Npm)) { throw "npm was not found next to $Node. Install npm for that Node and rerun." }

Write-Host "Installing $PackageSpec with Node $(& $Node --version)..."
$prefix = Join-Path $InstallDir "npm"
New-Item -ItemType Directory -Path $prefix -Force | Out-Null
# npm resolves `node` from PATH, so put the selected Node first.
# DevSpace and its dependencies ship prebuilt binaries, so no install scripts are needed.
$env:Path = "$NodeDir;$env:Path"
& $Npm install --global --prefix $prefix --ignore-scripts --no-fund --no-audit --no-update-notifier --loglevel=error $PackageSpec
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

$packageDir = Join-Path $prefix "node_modules\$Package"
if (-not (Test-Path (Join-Path $packageDir "bin\devspace.js"))) { throw "Install finished but $packageDir\bin\devspace.js is missing." }
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

$cmdNode = ConvertTo-CmdPath $Node
foreach ($command in @("devspace", "devspace-agentd")) {
  $cmdEntry = ConvertTo-CmdPath (Join-Path $packageDir "bin\$command.js")
  # Pin the Node that installed DevSpace so a version manager switching `node` cannot break it.
  # goto instead of an if (...) block: paths such as "Program Files (x86)" would close the block early.
  $launcher = @(
    "@echo off",
    "rem Generated by the DevSpace installer. Rerun the installer to update.",
    "if not exist `"$cmdNode`" goto missing",
    "`"$cmdNode`" `"$cmdEntry`" %*",
    "exit /b %errorlevel%",
    ":missing",
    "echo DevSpace's Node runtime is missing: `"$cmdNode`" 1>&2",
    "echo Rerun the DevSpace installer. 1>&2",
    "exit /b 1"
  ) -join "`r`n"
  Set-Content -Path (Join-Path $BinDir "$command.cmd") -Value $launcher -Encoding ASCII
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $BinDir) {
  if ($env:DEVSPACE_NO_MODIFY_PATH -eq "1") {
    Write-Host "Add $BinDir to your PATH to run devspace."
  } else {
    [Environment]::SetEnvironmentVariable("Path", (@($BinDir, $userPath) | Where-Object { $_ }) -join ";", "User")
    Write-Host "Added $BinDir to your user PATH (open a new terminal to pick it up)."
  }
}
$env:Path = "$BinDir;$env:Path"

$devspace = Join-Path $BinDir "devspace.cmd"
$version = & $devspace --version
if ($LASTEXITCODE -ne 0) { throw "The installed launcher at $devspace did not run." }
Write-Host "DevSpace $version is installed at $devspace"

if ($env:DEVSPACE_NO_INIT -ne "1") {
  Write-Host ""
  & $devspace init
  if ($LASTEXITCODE -ne 0) { Write-Host "Setup did not finish. Run ``devspace init`` to continue." }
}
