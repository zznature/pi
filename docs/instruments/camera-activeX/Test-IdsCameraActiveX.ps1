<#
.SYNOPSIS
    Smoke-test IDS camera access through an ActiveX/COM component.

.DESCRIPTION
    This script is intended for the lab Windows PC where LabSpec and the IDS
    camera software are installed. It first searches registered COM/ActiveX
    ProgIDs that look related to LabSpec/IDS/uEye/peak/camera, then optionally
    instantiates a selected ProgID and tries conservative discovery calls.

    The exact LabSpec ActiveX object model depends on the installed LabSpec
    version and licensed automation interface. Use -ProgId when the correct
    ProgID is known from HORIBA/IDS documentation or from the discovery output.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Test-IdsCameraActiveX.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Test-IdsCameraActiveX.ps1 -ProgId "LabSpec.Application" -ListMembers

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Test-IdsCameraActiveX.ps1 -ProgId "IDS.Camera" -Method OpenCamera -ListMembers
#>

[CmdletBinding()]
param(
    [string]$ProgId,
    [string]$Method,
    [object[]]$MethodArgs = @(),
    [switch]$ListMembers,
    [switch]$SkipDiscovery,
    [string]$LogPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $LogPath) {
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $LogPath = Join-Path $ScriptDir "camera_activex_test_$stamp.log"
}

function Write-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR", "OK")][string]$Level = "INFO"
    )

    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Level, $Message
    Write-Host $line
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

function Get-ComProgIdCandidates {
    $roots = @(
        "Registry::HKEY_CLASSES_ROOT",
        "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes",
        "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Classes",
        "Registry::HKEY_CURRENT_USER\Software\Classes"
    )
    $patterns = @("LabSpec", "HORIBA", "Jobin", "Yvon", "IDS", "uEye", "ueye", "peak", "Camera", "ActiveX")
    $items = New-Object System.Collections.Generic.List[object]

    foreach ($root in $roots) {
        if (-not (Test-Path $root)) {
            continue
        }

        Get-ChildItem -Path $root -ErrorAction SilentlyContinue |
            Where-Object { $_.PSChildName -notmatch "^(CLSID|Interface|TypeLib|AppID|Installer|Licenses)$" } |
            ForEach-Object {
                $name = $_.PSChildName
                $matches = $false
                foreach ($pattern in $patterns) {
                    if ($name -like "*$pattern*") {
                        $matches = $true
                        break
                    }
                }
                if (-not $matches) {
                    return
                }

                $clsid = $null
                $clsidPath = Join-Path $_.PSPath "CLSID"
                if (Test-Path $clsidPath) {
                    try {
                        $clsid = (Get-ItemProperty -Path $clsidPath -ErrorAction Stop)."(default)"
                    } catch {
                        $clsid = $null
                    }
                }

                $items.Add([pscustomobject]@{
                    ProgId = $name
                    Clsid = $clsid
                    RegistryRoot = $root
                })
            }
    }

    $items |
        Sort-Object ProgId, RegistryRoot -Unique |
        Where-Object { $_.ProgId -match "\." -or $_.ProgId -like "*LabSpec*" -or $_.ProgId -like "*IDS*" -or $_.ProgId -like "*uEye*" -or $_.ProgId -like "*peak*" }
}

function Get-MemberSummary {
    param([Parameter(Mandatory = $true)][object]$ComObject)

    $ComObject |
        Get-Member |
        Sort-Object MemberType, Name |
        Select-Object MemberType, Name, Definition
}

function Invoke-OptionalMethod {
    param(
        [Parameter(Mandatory = $true)][object]$ComObject,
        [Parameter(Mandatory = $true)][string]$Name,
        [object[]]$Args = @()
    )

    try {
        Write-Log "Trying method: $Name"
        $result = $ComObject.GetType().InvokeMember(
            $Name,
            [System.Reflection.BindingFlags]::InvokeMethod,
            $null,
            $ComObject,
            $Args
        )
        Write-Log "Method '$Name' returned: $result" "OK"
        return $true
    } catch {
        Write-Log "Method '$Name' failed: $($_.Exception.Message)" "WARN"
        return $false
    }
}

function Release-ComObject {
    param([object]$ComObject)

    if ($null -eq $ComObject) {
        return
    }

    try {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($ComObject)
        Write-Log "COM object released." "OK"
    } catch {
        Write-Log "COM release skipped/failed: $($_.Exception.Message)" "WARN"
    }
}

Write-Log "ActiveX camera test started."
Write-Log "PowerShell: $($PSVersionTable.PSVersion); Process bitness: $([IntPtr]::Size * 8)-bit"
Write-Log "Log file: $LogPath"

if (-not $SkipDiscovery) {
    Write-Log "Scanning registered COM/ActiveX ProgIDs related to LabSpec/IDS/uEye/peak/camera..."
    $candidates = @(Get-ComProgIdCandidates)
    if ($candidates.Count -eq 0) {
        Write-Log "No obvious camera/LabSpec COM ProgID found in registry." "WARN"
    } else {
        Write-Log "Found $($candidates.Count) candidate ProgID(s):" "OK"
        $candidates | Format-Table -AutoSize | Out-String | ForEach-Object {
            $_.TrimEnd() -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Write-Log $_ }
        }
    }
}

if (-not $ProgId) {
    Write-Log "No -ProgId supplied. Discovery finished; rerun with -ProgId '<candidate>' to instantiate a component." "INFO"
    exit 0
}

$camera = $null
try {
    Write-Log "Creating COM/ActiveX object: $ProgId"
    $camera = New-Object -ComObject $ProgId
    Write-Log "Created object for '$ProgId'." "OK"

    if ($ListMembers) {
        Write-Log "Listing visible members for '$ProgId'..."
        Get-MemberSummary -ComObject $camera | Format-Table -AutoSize | Out-String | ForEach-Object {
            $_.TrimEnd() -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Write-Log $_ }
        }
    }

    if ($Method) {
        [void](Invoke-OptionalMethod -ComObject $camera -Name $Method -Args $MethodArgs)
    } else {
        Write-Log "No -Method supplied. Trying conservative common initialization/acquisition method names."
        $commonMethods = @(
            "Initialize",
            "Init",
            "Connect",
            "Open",
            "OpenCamera",
            "Start",
            "StartLive",
            "StartAcquisition",
            "Grab",
            "Snap",
            "Capture",
            "StopAcquisition",
            "StopLive",
            "Stop",
            "Close"
        )

        foreach ($name in $commonMethods) {
            [void](Invoke-OptionalMethod -ComObject $camera -Name $name)
        }
    }
} catch {
    Write-Log "Test failed: $($_.Exception.Message)" "ERROR"
    if ($_.Exception.InnerException) {
        Write-Log "Inner exception: $($_.Exception.InnerException.Message)" "ERROR"
    }
    exit 1
} finally {
    Release-ComObject -ComObject $camera
}

Write-Log "ActiveX camera test finished."
