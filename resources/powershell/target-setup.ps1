#requires -Version 5.1

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RemoteAddress = 'Any'
)

$ErrorActionPreference = 'Stop'

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Administrator permission is required. Requesting elevation...' -ForegroundColor Yellow
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($PSBoundParameters.ContainsKey('RemoteAddress')) {
        $arguments += @('-RemoteAddress', $RemoteAddress)
    }
    $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $elevated.ExitCode
}

Write-Host 'Configuring PowerShell remoting for CHICTool...' -ForegroundColor Cyan

if ($PSCmdlet.ShouldProcess('WinRM and PowerShell Remoting', 'Enable')) {
    Enable-PSRemoting -Force
}

if ($PSCmdlet.ShouldProcess('Windows Firewall', 'Allow WinRM HTTP inbound traffic')) {
    $rules = Get-NetFirewallRule -Name 'WINRM-HTTP-In-TCP' -ErrorAction SilentlyContinue
    if ($rules) {
        $rules | Set-NetFirewallRule -Enabled True -Profile Domain,Private -RemoteAddress $RemoteAddress
    } else {
        New-NetFirewallRule -Name 'WINRM-HTTP-In-TCP' -DisplayName 'Windows Remote Management (HTTP-In)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5985 -Profile Domain,Private -RemoteAddress $RemoteAddress
    }
}

Write-Host ''
Write-Host '[Verification] Checking WinRM service...' -ForegroundColor Cyan
try {
    $winrm = Get-Service -Name WinRM -ErrorAction Stop
    if ($winrm.Status -ne 'Running') {
        Start-Service -Name WinRM -ErrorAction Stop
        $winrm.WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
    }

    Write-Host '[Verification] Checking WINRM-HTTP-In-TCP firewall rule...' -ForegroundColor Cyan
    $rule = Get-NetFirewallRule -Name 'WINRM-HTTP-In-TCP' -ErrorAction Stop
    if ($rule.Enabled -ne 'True') {
        throw 'WINRM-HTTP-In-TCP exists but is disabled.'
    }
    $portFilter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop
    if (-not ($portFilter.LocalPort -contains '5985' -or $portFilter.LocalPort -contains 5985 -or $portFilter.LocalPort -eq 'Any')) {
        throw 'WINRM-HTTP-In-TCP does not allow TCP port 5985.'
    }

    Write-Host '[Verification] Testing local WinRM listener...' -ForegroundColor Cyan
    Test-WSMan -ComputerName 'localhost' -ErrorAction Stop | Out-Null
}
catch {
    Write-Host "Target setup verification failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'Target setup and verification completed.' -ForegroundColor Green
Write-Host 'Verify remotely from the admin computer with: Test-WSMan <target-hostname-or-ip>'
