$ErrorActionPreference = 'Stop'
$installer = Join-Path (Split-Path $PSScriptRoot) 'install.ps1'
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('creview installer ' + [guid]::NewGuid())
$bin = Join-Path $temp 'bin'
$presets = '{"presets":[]}'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
function Assert($condition, $message) { if (-not $condition) { throw $message } }
try {
    $fixture = Join-Path $temp 'fake.ps1'
    @'
$Tool = $args[0]
$Rest = @($args | Select-Object -Skip 1)
Add-Content -LiteralPath $env:INSTALL_LOG -Value ($Tool + '|' + ($Rest -join '|'))
if ($Tool -eq 'git') {
    $Mode = $env:INSTALL_MODE
    if ($Rest[0] -eq 'clone') {
        if ($Mode -eq 'clone-fail') { exit 7 }
        New-Item -ItemType Directory -Path $Rest[-1] -Force | Out-Null
        exit 0
    }
    $Main = Join-Path $Rest[1] 'main.ref'
    $Tracking = Join-Path $Rest[1] 'origin-main.ref'
    $Fetched = Join-Path $Rest[1] 'fetch-head.ref'
    switch ($Rest[2]) {
        'rev-parse' {
            # The .cmd launcher may strip the caret from rev-parse commit selectors.
            switch -Wildcard ($Rest[-1]) {
                '--show-toplevel' {
                    if ($Mode -eq 'not-repo') { exit 8 }
                    if ($Mode -eq 'nested') { Split-Path $Rest[1] } else { $Rest[1] }
                }
                'HEAD*' {
                    if ($Mode -eq 'head-fail') { exit 8 }
                    Get-Content -LiteralPath $Main
                }
                'refs/remotes/origin/main*' {
                    if ($Mode -eq 'tracking-fail') { exit 8 }
                    Get-Content -LiteralPath $Tracking
                }
                'FETCH_HEAD*' {
                    if ($Mode -eq 'target-fail') { exit 8 }
                    Get-Content -LiteralPath $Fetched
                }
                default { exit 9 }
            }
        }
        'remote' {
            if ($Mode -eq 'wrong-origin') { 'https://github.com/other/repo.git' }
            else { 'https://github.com/exphck1337/creview.git' }
        }
        'symbolic-ref' {
            if ($Mode -eq 'detached') { exit 1 }
            if ($Mode -eq 'other-branch') { 'refs/heads/feature' } else { 'refs/heads/main' }
        }
        'status' {
            if ($Mode -eq 'status-fail') { exit 8 }
            if ($Mode -eq 'dirty') { 'M  install.ps1' }
            if ($Rest -notcontains '--untracked-files=no') { '?? creview.json' }
        }
        'fetch' {
            if ($Mode -eq 'fetch-fail') { exit 7 }
            Set-Content -LiteralPath $Fetched -Value $env:INSTALL_TARGET
            if ($Rest -notcontains '--refmap=') {
                Set-Content -LiteralPath $Tracking -Value $env:INSTALL_TARGET
            }
        }
        'merge-base' {
            if ($Mode -eq 'ancestry-fail') { exit 8 }
            if ($Rest[-1] -ne 'new' -or $Rest[-2] -notin 'base', 'local') { exit 1 }
        }
        'checkout' {
            if ($Mode -eq 'checkout-fail') { exit 7 }
            if ($Mode -eq 'ignored-collision') {
                if ($Rest -contains '--no-overwrite-ignore') { exit 7 }
                Set-Content -LiteralPath (Join-Path $Rest[1] 'creview.json') -Value 'upstream version'
            }
            Set-Content -LiteralPath $Main -Value $Rest[-1]
        }
        'update-ref' {
            if ($Mode -eq 'update-ref-fail' -or $Rest[5] -ne (Get-Content -LiteralPath $Tracking)) { exit 7 }
            Set-Content -LiteralPath $Tracking -Value $Rest[4]
        }
        default { exit 9 }
    }
} elseif ($env:INSTALL_MODE -eq ($Tool + '-fail')) { exit 6 }
exit 0
'@ | Set-Content -LiteralPath $fixture
    foreach ($tool in 'git', 'pi', 'omp') {
        "@echo off`r`n`"$powerShell`" -NoProfile -ExecutionPolicy Bypass -File `"$fixture`" $tool %*`r`nexit /b %errorlevel%" | Set-Content -LiteralPath (Join-Path $bin "$tool.cmd")
    }
    function Run([string[]]$selections, $mode = '', $existing = $false, $missing = '', $localHead = 'base', $targetHead = 'base') {
        $homePath = Join-Path $temp ([guid]::NewGuid().ToString() + ' home space')
        New-Item -ItemType Directory -Path $homePath | Out-Null
        $destination = Join-Path $homePath '.creview'
        if ($existing) {
            New-Item -ItemType Directory -Path $destination | Out-Null
            [IO.File]::WriteAllText((Join-Path $destination 'creview.json'), $presets)
            Set-Content -LiteralPath (Join-Path $destination 'main.ref') -Value $localHead
            Set-Content -LiteralPath (Join-Path $destination 'origin-main.ref') -Value 'base'
        }
        $log = Join-Path $homePath 'calls.log'
        $command = "Set-Variable HOME '$($homePath.Replace("'", "''"))' -Force; Get-Content -Raw -LiteralPath '$($installer.Replace("'", "''"))' | Invoke-Expression"
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $powerShell
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
        $info.Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
        $info.UseShellExecute = $false
        $info.RedirectStandardInput = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.EnvironmentVariables['PATH'] = "$bin;$env:SystemRoot\System32"
        $info.EnvironmentVariables['HOME'] = $homePath
        $info.EnvironmentVariables['USERPROFILE'] = $homePath
        $info.EnvironmentVariables['INSTALL_LOG'] = $log
        $info.EnvironmentVariables['INSTALL_MODE'] = $mode
        $info.EnvironmentVariables['INSTALL_TARGET'] = $targetHead
        $hidden = Join-Path $bin "$missing.cmd"
        if ($missing) { Move-Item -LiteralPath $hidden -Destination "$hidden.hidden" }
        try {
            $process = [Diagnostics.Process]::Start($info)
            foreach ($selection in $selections) { $process.StandardInput.WriteLine($selection) }
            $process.StandardInput.Close()
            $outTask = $process.StandardOutput.ReadToEndAsync()
            $errTask = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Installer child timed out' }
            $stdout = $outTask.GetAwaiter().GetResult()
            $stderr = $errTask.GetAwaiter().GetResult()
            $code = $process.ExitCode
            $process.Dispose()
        } finally {
            if ($missing) { Move-Item -LiteralPath "$hidden.hidden" -Destination $hidden }
        }
        $calls = @()
        if (Test-Path -LiteralPath $log) { $calls = @(Get-Content -LiteralPath $log) }
        [pscustomobject]@{ Code = $code; Output = "$stdout`n$stderr"; Calls = $calls; Destination = $destination }
    }
    function Assert-ExistingState($result, $head, $tracking, $scenario) {
        Assert ([IO.File]::ReadAllText((Join-Path $result.Destination 'creview.json')) -ceq $presets) "$scenario changed creview.json"
        Assert ((Get-Content -LiteralPath (Join-Path $result.Destination 'main.ref')) -ceq $head) "$scenario left main at the wrong commit"
        Assert ((Get-Content -LiteralPath (Join-Path $result.Destination 'origin-main.ref')) -ceq $tracking) "$scenario left origin/main at the wrong commit"
    }
    $checklists = @(
        @{ Lines = @('1', ''); Hosts = @('pi'); Rows = '  \[x\] 1\) pi\r?\n  \[ \] 2\) omp' }
        @{ Lines = @('2', ''); Hosts = @('omp'); Rows = '  \[ \] 1\) pi\r?\n  \[x\] 2\) omp' }
        @{ Lines = @('2', '1', ''); Hosts = @('pi', 'omp'); Rows = '  \[x\] 1\) pi\r?\n  \[x\] 2\) omp' }
        @{ Lines = @('2', '1', '2', ''); Hosts = @('pi'); Rows = '  \[x\] 1\) pi\r?\n  \[ \] 2\) omp' }
    )
    foreach ($checklist in $checklists) {
        $result = Run $checklist.Lines
        Assert ($result.Code -eq 0) "Checklist $($checklist.Lines -join ',') failed: $($result.Output)"
        Assert ($result.Output -match 'Install creview for:\r?\n  \[ \] 1\) pi\r?\n  \[ \] 2\) omp') 'Initial checklist rows were not both unchecked'
        Assert ($result.Output -match $checklist.Rows) 'Final checklist did not show the expected checked hosts'
        Assert ($result.Calls.Count -eq (1 + $checklist.Hosts.Count)) 'Unexpected CLI calls'
        Assert ($result.Calls[0] -match '^git\|clone\|') 'Expected clone before registration'
        for ($i = 0; $i -lt $checklist.Hosts.Count; $i++) {
            Assert ($result.Calls[$i + 1] -eq "$($checklist.Hosts[$i])|install|$($result.Destination)") 'Registration path, host, or order mismatch'
        }
        Assert ($result.Output -match '/creview-config') 'Missing completion instructions'
    }
    $both = @('1', '2', '')
    $updates = @(
        @{ Mode = 'up-to-date'; Head = 'base'; Target = 'base'; Notice = 'creview is already up to date in' }
        @{ Mode = 'update'; Head = 'base'; Target = 'new'; Notice = 'Updated creview in' }
        @{ Mode = 'fast-forward'; Head = 'local'; Target = 'new'; Notice = 'Updated creview in' }
        @{ Mode = 'rewrite'; Head = 'base'; Target = 'rewrite'; Notice = 'Updated creview in' }
        @{ Mode = 'tracking-only'; Head = 'new'; Target = 'new'; Notice = 'creview is already up to date in' }
    )
    foreach ($update in $updates) {
        $result = Run @('2', '') $update.Mode $true -localHead $update.Head -targetHead $update.Target
        Assert ($result.Code -eq 0) "$($update.Mode) failed: $($result.Output)"
        Assert ($result.Output.Contains("$($update.Notice) $($result.Destination)")) "Missing $($update.Mode) notice"
        Assert-ExistingState $result $update.Target $update.Target $update.Mode
        Assert ((Get-Content -LiteralPath (Join-Path $result.Destination 'fetch-head.ref')) -ceq $update.Target) "$($update.Mode) did not fetch the target"
        $registrations = @($result.Calls -match '^(pi|omp)\|')
        Assert ($registrations.Count -eq 1 -and $registrations[0] -eq "omp|install|$($result.Destination)") "$($update.Mode) did not register only omp"
    }

    $updateFailures = @(
        @{ Mode = 'other-branch'; Message = 'check out main'; BeforeFetch = $true }
        @{ Mode = 'detached'; Message = 'check out main'; BeforeFetch = $true }
        @{ Mode = 'dirty'; Message = 'uncommitted tracked changes'; BeforeFetch = $true }
        @{ Mode = 'status-fail'; Message = 'Git status failed'; BeforeFetch = $true }
        @{ Mode = 'head-fail'; Message = 'could not resolve HEAD'; BeforeFetch = $true }
        @{ Mode = 'tracking-fail'; Message = 'could not resolve origin/main'; BeforeFetch = $true }
        @{ Mode = 'fetch-fail'; Message = 'Git fetch failed' }
        @{ Mode = 'target-fail'; Message = 'could not resolve FETCH_HEAD' }
        @{ Mode = 'ancestry-fail'; Message = 'Git could not check main ancestry'; Head = 'local' }
        @{ Mode = 'diverged'; Message = 'local commits'; Head = 'local'; Target = 'rewrite' }
        @{ Mode = 'checkout-fail'; Message = 'Git checkout failed' }
        @{ Mode = 'ignored-collision'; Message = 'Git checkout failed' }
        @{ Mode = 'update-ref-fail'; Message = 'could not update origin/main'; Checkout = $true }
    )
    foreach ($failure in $updateFailures) {
        $head = if ($failure.Head) { $failure.Head } else { 'base' }
        $target = if ($failure.Target) { $failure.Target } else { 'new' }
        $result = Run $both $failure.Mode $true -localHead $head -targetHead $target
        Assert ($result.Code -ne 0) "$($failure.Mode) update unexpectedly succeeded"
        Assert ($result.Output.Contains($failure.Message)) "Missing $($failure.Mode) error: $($result.Output)"
        Assert (-not ($result.Calls -match '^(pi|omp)\|')) "$($failure.Mode) registered a host"
        Assert ($result.Output -notmatch 'Updated creview|already up to date|Restart ') "$($failure.Mode) printed success"
        if ($failure.BeforeFetch) {
            Assert (-not ($result.Calls -match '\|fetch\|')) "$($failure.Mode) fetched before validation succeeded"
        }
        if ($failure.Checkout) { $head = $target }
        Assert-ExistingState $result $head 'base' $failure.Mode
    }
    $rejections = @(
        @{ Lines = @('invalid'); Message = 'Invalid selection; nothing changed.' }
        @{ Lines = @('1', '3', ''); Message = 'Invalid selection; nothing changed.' }
        @{ Lines = @(''); Message = 'No hosts selected; nothing changed.' }
        @{ Lines = @('1', '1', ''); Message = 'No hosts selected; nothing changed.' }
        @{ Lines = @('1'); Message = 'Invalid selection; nothing changed.' }
    )
    foreach ($rejection in $rejections) {
        $result = Run $rejection.Lines
        Assert ($result.Code -ne 0 -and $result.Calls.Count -eq 0 -and -not (Test-Path $result.Destination)) "Rejected checklist $($rejection.Lines -join ',') wrote or succeeded"
        Assert ($result.Output.Contains($rejection.Message)) "Missing rejection message: $($result.Output)"
    }
    foreach ($missing in 'git', 'pi', 'omp') {
        $result = Run $both '' $false $missing
        Assert ($result.Code -ne 0 -and $result.Calls.Count -eq 0 -and -not (Test-Path $result.Destination)) "Missing $missing did not stop before clone"
    }
    foreach ($mode in 'clone-fail', 'pi-fail', 'omp-fail') {
        $result = Run $both $mode
        Assert ($result.Code -ne 0) "$mode was ignored"
        Assert ($result.Output -notmatch 'Restart pi and omp') "$mode printed completion"
        if ($mode -ne 'omp-fail') { Assert (-not ($result.Calls -match '^omp\|')) "$mode continued to omp" }
    }
    foreach ($mode in 'not-repo', 'nested', 'wrong-origin') {
        $result = Run $both $mode $true
        Assert ($result.Code -ne 0 -and -not ($result.Calls -match '^(pi|omp)\|')) "$mode was registered"
        Assert-ExistingState $result 'base' 'base' $mode
    }
    Write-Host 'PASS: PowerShell 5.1 installer checklist, updates and update failures, preset preservation, missing dependencies, native failures and foreign folders.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force
}
