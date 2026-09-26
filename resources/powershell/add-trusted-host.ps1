#requires -Version 5.1

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [string]$HostName
)

$ErrorActionPreference = 'Stop'

# Do not allow broad or ambiguous TrustedHosts entries.
if ($HostName -match '[,;*\s]') {
    throw 'HostName must contain one hostname or IP address only; wildcards and lists are not allowed.'
}

$trustedHostsPath = 'WSMan:\localhost\Client\TrustedHosts'
$current = (Get-Item -LiteralPath $trustedHostsPath -ErrorAction Stop).Value
$entries = @($current -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })

if ($entries -contains $HostName) {
    Write-Output "Already present in TrustedHosts: $HostName"
    exit 0
}

$updated = (($entries + $HostName) -join ',')
if ($PSCmdlet.ShouldProcess($trustedHostsPath, "Add $HostName")) {
    Set-Item -LiteralPath $trustedHostsPath -Value $updated -Force
    Write-Output "Added to TrustedHosts: $HostName"
    Write-Output "TrustedHosts is now: $updated"
}
