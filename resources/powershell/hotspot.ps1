param(
    [Parameter(Mandatory = $true)][ValidateSet('Status', 'Start', 'Stop', 'Firewall', 'FirewallAdmin')][string]$Action,
    [string]$NetworkName,
    [string]$Passkey,
    [ValidateRange(1, 65535)][int]$ScanPort = 4783
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

function Wait-WinRt([object]$Operation, [Type]$ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.GetGenericTypeDefinition().FullName -eq 'Windows.Foundation.IAsyncOperation`1'
    } | Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
}

function Wait-WinRtAction([object]$Operation) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and -not $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.FullName -eq 'Windows.Foundation.IAsyncAction'
    } | Select-Object -First 1
    $task = $method.Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
}

function Test-ScanFirewallRule {
    $firewallRuleName = 'CHICTool-Network-Scan-In-TCP'
    $rules = Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue
    foreach ($rule in $rules) {
        if ($rule.Enabled -ne 'True' -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow') { continue }
        $portFilters = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction SilentlyContinue
        foreach ($portFilter in $portFilters) {
            if ($portFilter.Protocol -in @('TCP', '6') -and [string]$portFilter.LocalPort -eq [string]$ScanPort) {
                return $true
            }
        }
    }
    return $false
}

try {
    if ($Action -eq 'Firewall') {
        if (Test-ScanFirewallRule) {
            [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
            exit 0
        }
        $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action FirewallAdmin -ScanPort $ScanPort"
        $elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        if ($elevated.ExitCode -ne 0) { throw 'Could not add the CHICTool scan endpoint to Windows Firewall. Approve the Windows permission prompt and try again.' }
        [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
        exit 0
    }

    if ($Action -eq 'FirewallAdmin') {
        $firewallRuleName = 'CHICTool-Network-Scan-In-TCP'
        if (Test-ScanFirewallRule) {
            [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
            exit 0
        }
        $existingRule = Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue
        if ($existingRule) {
            $existingRule | Remove-NetFirewallRule
        }
        New-NetFirewallRule -Name $firewallRuleName -DisplayName 'CHICTool Network Scan Endpoint' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $ScanPort -Profile Any | Out-Null
        [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
        exit 0
    }

    $connectionProfile = [Windows.Networking.Connectivity.NetworkInformation, Windows, ContentType=WindowsRuntime]::GetInternetConnectionProfile()
    if (-not $connectionProfile) { throw 'No active internet connection is available to share.' }
    $managerType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows, ContentType=WindowsRuntime]
    $capability = $managerType::GetTetheringCapabilityFromConnectionProfile($connectionProfile)
    if ($capability.ToString() -ne 'Enabled') { throw "Mobile Hotspot is unavailable: $capability" }
    $manager = $managerType::CreateFromConnectionProfile($connectionProfile)
    if ($Action -eq 'Start') {
        if ([string]::IsNullOrWhiteSpace($NetworkName)) { throw 'Hotspot name is required.' }
        if ([string]::IsNullOrWhiteSpace($Passkey) -or $Passkey.Length -lt 8) { throw 'Hotspot password must be at least 8 characters.' }
        $configuration = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringAccessPointConfiguration, Windows, ContentType=WindowsRuntime]::new()
        $configuration.Ssid = $NetworkName
        $configuration.Passphrase = $Passkey
        Wait-WinRtAction ($manager.ConfigureAccessPointAsync($configuration))
        $resultType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult, Windows, ContentType=WindowsRuntime]
        $result = Wait-WinRt ($manager.StartTetheringAsync()) $resultType
        if ($result.Status.ToString() -ne 'Success') { throw "Could not start Mobile Hotspot: $($result.Status) $($result.AdditionalErrorMessage)" }
    }
    if ($Action -eq 'Stop') {
        $resultType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult, Windows, ContentType=WindowsRuntime]
        $stopError = $null
        try {
            $result = Wait-WinRt ($manager.StopTetheringAsync()) $resultType
            if ($result.Status.ToString() -ne 'Success') {
                $stopError = "Windows returned $($result.Status) $($result.AdditionalErrorMessage)"
            }
        } catch {
            $stopError = $_.Exception.Message
        }
        if ($stopError) {
            $deadline = (Get-Date).AddSeconds(5)
            do {
                if ($manager.TetheringOperationalState.ToString() -eq 'Off') {
                    $stopError = $null
                    break
                }
                Start-Sleep -Milliseconds 500
            } while ((Get-Date) -lt $deadline)
            if ($stopError) { throw "Could not stop Mobile Hotspot: $stopError" }
        }
    }
    $accessPoint = $manager.GetCurrentAccessPointConfiguration()
    [pscustomobject]@{ ok = $true; state = $manager.TetheringOperationalState.ToString(); clientCount = @($manager.GetTetheringClients()).Count; networkName = $accessPoint.Ssid } | ConvertTo-Json -Compress
} catch {
    [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
