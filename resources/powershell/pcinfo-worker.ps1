$ErrorActionPreference = 'Stop'

function New-WorkerCredential {
    param(
        [string]$Username,
        [string]$Passkey
    )

    # The password arrives through stdin and is never written to disk or logs.
    # PSCredential still requires a SecureString for WinRM, so build it directly
    # with .NET instead of depending on Microsoft.PowerShell.Security.
    $securePassword = New-Object System.Security.SecureString
    foreach ($character in $Passkey.ToCharArray()) {
        $securePassword.AppendChar($character)
    }
    $securePassword.MakeReadOnly()
    return [System.Management.Automation.PSCredential]::new($Username, $securePassword)
}

function Convert-ToCleanString([object]$Value) {
    if ($null -eq $Value) { return '' }
    return ([string]$Value).Trim()
}

function Get-MarketedDiskSize([UInt64]$Bytes) {
    if ($Bytes -le 0) { return 'Unknown' }
    $sizeGb = $Bytes / 1GB
    switch ($sizeGb) {
        { $_ -lt 200 } { return '120GB' }
        { $_ -lt 350 } { return '250GB' }
        { $_ -lt 750 } { return '500GB' }
        { $_ -lt 1500 } { return '1TB' }
        { $_ -lt 3000 } { return '2TB' }
        { $_ -lt 6000 } { return '4TB' }
        default { return ('{0:N0} TB' -f [math]::Round($sizeGb / 1024)) }
    }
}

function Get-MatchedMacAddress {
    param([string]$TargetAddress)

    $adapters = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.MacAddress })
    if ([string]::IsNullOrWhiteSpace($TargetAddress)) {
        return @($adapters | Select-Object -ExpandProperty MacAddress | Sort-Object -Unique)
    }

    $targetIps = @()
    try {
        $parsedAddress = [System.Net.IPAddress]::Parse($TargetAddress)
        $targetIps += $parsedAddress.IPAddressToString
    } catch {
        try {
            $targetIps += @(Resolve-DnsName -Name $TargetAddress -ErrorAction Stop |
                Where-Object { $_.Type -in @('A', 'AAAA') } |
                Select-Object -ExpandProperty IPAddress)
        } catch {
            $targetIps = @()
        }
    }

    if ($targetIps.Count -eq 0) { return @() }

    $matchingInterfaceIndexes = @(Get-NetIPAddress -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -in $targetIps } |
        Select-Object -ExpandProperty InterfaceIndex -Unique)
    if ($matchingInterfaceIndexes.Count -eq 0) { return @() }

    return @($adapters |
        Where-Object { $_.ifIndex -in $matchingInterfaceIndexes } |
        Select-Object -ExpandProperty MacAddress |
        Sort-Object -Unique)
}

function Get-InventoryDetails {
    param([string]$TargetAddress)
    $baseboard = Get-CimInstance Win32_BaseBoard | Select-Object -First 1
    $computerSystem = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1
    $cpu = @(Get-CimInstance Win32_Processor)
    $memory = @(Get-CimInstance Win32_PhysicalMemory)
    $os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1
    $gpu = @(Get-CimInstance Win32_VideoController | Where-Object PNPDeviceID -match '^PCI' | Select-Object -ExpandProperty Caption)
    $mac = @(Get-MatchedMacAddress -TargetAddress $TargetAddress)
    $disks = @(Get-PhysicalDisk | Where-Object { $_.BusType -notin @('USB', 'Unknown') -and $_.MediaType -ne 'Unspecified' })
    $storageParts = (($disks | Select-Object -ExpandProperty FriendlyName | Sort-Object -Unique | ForEach-Object { "$_".Trim() }) -join ', ')
    $memoryParts = (($memory | Select-Object -ExpandProperty PartNumber | Sort-Object -Unique | ForEach-Object { "$_".Trim() }) -join ', ')
    $hardwareDetails = ("Storage Parts: $storageParts; `nMemory Parts: $memoryParts" -replace ' +', ' ')
    $serial = Convert-ToCleanString $baseboard.SerialNumber
    if ([string]::IsNullOrWhiteSpace($serial) -or $serial -match '(?i)To Be Filled|Default|None|Unknown|O\.E\.M') {
        $serial = 'UUID:' + (Get-CimInstance Win32_ComputerSystemProduct).UUID
    }
    [PSCustomObject]@{
        serial_number = $serial
        primary_user = Convert-ToCleanString $computerSystem.UserName
        manufacturer = Convert-ToCleanString $baseboard.Manufacturer
        model = Convert-ToCleanString $baseboard.Product
        operating_system = ('{0} {1}' -f (Convert-ToCleanString $os.Caption), (Convert-ToCleanString $os.OSArchitecture)).Trim()
        processor = (($cpu | Select-Object -ExpandProperty Name) -replace '\((tm|r)\)', '') -join ', '
        storage = (($disks | Group-Object { "$(Get-MarketedDiskSize $_.Size) $($_.MediaType)" } | ForEach-Object {
            $prefix = if ($_.Count -gt 1) { "$($_.Count) x " } else { '' }; "$prefix$($_.Name)"
        }) -join ', ')
        memory = '{0:N0}GB' -f (($memory | Measure-Object Capacity -Sum).Sum / 1GB)
        gpu = (($gpu -replace '\((tm|r)\)') | Sort-Object -Unique) -join ', '
        mac_address = $mac -join ', '
        details = $hardwareDetails
    }
}

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.mode -eq 'remote') {
        if ([string]::IsNullOrWhiteSpace($request.hostname)) { throw 'Hostname is required.' }
        $credential = New-WorkerCredential -Username ([string]$request.username) -Passkey ([string]$request.password)
        $request.password = $null
        if ($request.operation -eq 'test') {
            $data = Invoke-Command -ComputerName ([string]$request.hostname) -Credential $credential -ScriptBlock {
                [PSCustomObject]@{ hostname = $env:COMPUTERNAME }
            } -ErrorAction Stop
        } else {
            $definition = @(
                'function Convert-ToCleanString {'
                ${function:Convert-ToCleanString}.ToString()
                '}'
                'function Get-MarketedDiskSize {'
                ${function:Get-MarketedDiskSize}.ToString()
                '}'
                'function Get-MatchedMacAddress {'
                ${function:Get-MatchedMacAddress}.ToString()
                '}'
                'function Get-InventoryDetails {'
                ${function:Get-InventoryDetails}.ToString()
                '}'
            ) -join "`n"
            $data = Invoke-Command -ComputerName ([string]$request.hostname) -Credential $credential -ScriptBlock {
                param($functionDefinition, $targetAddress)
                . ([scriptblock]::Create($functionDefinition)); Get-InventoryDetails -TargetAddress $targetAddress
            } -ArgumentList $definition, ([string]$request.hostname) -ErrorAction Stop
        }
    } else {
        $data = Get-InventoryDetails
    }
    [PSCustomObject]@{ ok = $true; data = $data } | ConvertTo-Json -Depth 5 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
