& {
    $ErrorActionPreference = 'Stop'
    $piChecked = $false
    $ompChecked = $false
    if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
        if ([Console]::CursorLeft -ne 0) { [Console]::WriteLine() }
        $width = [Console]::WindowWidth - 1
        foreach ($line in @('Install creview for:', 'Up/Down moves; Space toggles', 'Enter installs; Esc cancels')) {
            [Console]::WriteLine($line.Substring(0, [Math]::Min($line.Length, $width)))
        }
        # Reserve both rows before repainting, so any buffer scroll happens here.
        [Console]::WriteLine()
        [Console]::WriteLine()

        $focus = 0
        do {
            $piMark = if ($piChecked) { 'x' } else { ' ' }
            $ompMark = if ($ompChecked) { 'x' } else { ' ' }
            $rows = @("[$piMark] pi", "[$ompMark] omp")
            $belowRows = [Console]::CursorTop
            $width = [Console]::WindowWidth - 1
            for ($row = 0; $row -lt $rows.Count; $row++) {
                $pointer = if ($row -eq $focus) { '>' } else { ' ' }
                $line = "$pointer $($rows[$row])"
                [Console]::SetCursorPosition(0, ($belowRows - $rows.Count + $row))
                [Console]::Write($line.Substring(0, [Math]::Min($line.Length, $width)))
            }
            [Console]::SetCursorPosition(0, $belowRows)

            $key = [Console]::ReadKey($true).Key
            switch ($key) {
                'UpArrow' { $focus = 0 }
                'DownArrow' { $focus = 1 }
                'Spacebar' {
                    if ($focus -eq 0) { $piChecked = -not $piChecked }
                    else { $ompChecked = -not $ompChecked }
                }
                'Escape' {
                    Write-Host 'Cancelled; nothing changed.'
                    return
                }
            }
        } while ($key -ne 'Enter' -or -not ($piChecked -or $ompChecked))
    } else {
        $prompt = 'Type 1 or 2 to toggle, or press Enter to install'
        do {
            $piMark = if ($piChecked) { 'x' } else { ' ' }
            $ompMark = if ($ompChecked) { 'x' } else { ' ' }
            Write-Host 'Install creview for:'
            Write-Host "  [$piMark] 1) pi"
            Write-Host "  [$ompMark] 2) omp"
            $choice = Read-Host $prompt
            if ($null -eq $choice) { throw 'Invalid selection; nothing changed.' }
            switch ($choice) {
                '1' { $piChecked = -not $piChecked }
                '2' { $ompChecked = -not $ompChecked }
                '' { }
                default { throw 'Invalid selection; nothing changed.' }
            }
        } while ($choice -ne '')
    }

    $hosts = @(
        if ($piChecked) { 'pi' }
        if ($ompChecked) { 'omp' }
    )
    if ($hosts.Count -eq 0) { throw 'No hosts selected; nothing changed.' }

    $commands = @{}
    foreach ($name in @('git') + $hosts) {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $command) { throw "Required command '$name' was not found. Install it first, then run this installer again." }
        $commands[$name] = $command.Source
    }

    $destination = Join-Path $HOME '.creview'
    $repository = 'https://github.com/exphck1337/creview.git'
    if (Test-Path -LiteralPath $destination) {
        $root = & $commands['git'] -C $destination rev-parse --show-toplevel
        if ($LASTEXITCODE -ne 0) { throw "Existing path is not a creview clone: $destination" }
        $expected = [IO.Path]::GetFullPath($destination).TrimEnd('\', '/')
        if ([IO.Path]::GetFullPath([string]$root).TrimEnd('\', '/') -ne $expected) {
            throw "Existing path is not the root of a creview clone: $destination"
        }
        $origin = & $commands['git'] -C $destination remote get-url origin
        if ($LASTEXITCODE -ne 0 -or $origin -cnotmatch '^(https://github\.com/exphck1337/creview(?:\.git)?/?|git@github\.com:exphck1337/creview(?:\.git)?|ssh://git@github\.com/exphck1337/creview(?:\.git)?)$') {
            throw "Existing clone does not have the creview origin: $destination"
        }
        $branch = & $commands['git'] -C $destination symbolic-ref --quiet HEAD
        if ($LASTEXITCODE -ne 0 -or $branch -cne 'refs/heads/main') {
            throw "Cannot update creview: check out main in $destination and run the installer again."
        }
        $status = & $commands['git'] -C $destination status --porcelain --untracked-files=no
        if ($LASTEXITCODE -ne 0) { throw 'Cannot update creview: Git status failed.' }
        if ($status) { throw 'Cannot update creview: main has uncommitted tracked changes.' }

        $trackingRef = 'refs/remotes/origin/main'
        $head = & $commands['git'] -C $destination rev-parse --verify 'HEAD^{commit}'
        if ($LASTEXITCODE -ne 0) { throw 'Cannot update creview: could not resolve HEAD.' }
        $prior = & $commands['git'] -C $destination rev-parse --verify "${trackingRef}^{commit}"
        if ($LASTEXITCODE -ne 0) { throw 'Cannot update creview: could not resolve origin/main.' }

        # Leave origin/main unchanged until the checkout succeeds.
        & $commands['git'] -C $destination fetch --no-tags --refmap= origin refs/heads/main
        if ($LASTEXITCODE -ne 0) { throw 'Cannot update creview: Git fetch failed.' }
        $target = & $commands['git'] -C $destination rev-parse --verify 'FETCH_HEAD^{commit}'
        if ($LASTEXITCODE -ne 0) { throw 'Cannot update creview: could not resolve FETCH_HEAD.' }

        if ($head -ne $target) {
            # A published rewrite is safe if main still matches the old origin/main.
            if ($head -ne $prior) {
                & $commands['git'] -C $destination merge-base --is-ancestor $head $target
                if ($LASTEXITCODE -eq 1) { throw 'Cannot update creview: main has local commits that are not in the fetched main.' }
                if ($LASTEXITCODE -ne 0) { throw 'Cannot update creview: Git could not check main ancestry.' }
            }
            & $commands['git'] -C $destination checkout --no-overwrite-ignore -B main $target
            if ($LASTEXITCODE -ne 0) { throw 'Cannot update creview: Git checkout failed.' }
        }
        if ($prior -ne $target) {
            & $commands['git'] -C $destination update-ref $trackingRef $target $prior
            if ($LASTEXITCODE -ne 0) { throw 'Cannot update creview: could not update origin/main.' }
        }

        if ($head -eq $target) {
            Write-Host "creview is already up to date in $destination."
        } else {
            Write-Host "Updated creview in $destination."
        }
    } else {
        & $commands['git'] clone --branch main -- $repository $destination
        if ($LASTEXITCODE -ne 0) { throw 'Git clone failed; no host was registered.' }
    }

    foreach ($name in $hosts) {
        & $commands[$name] install $destination
        if ($LASTEXITCODE -ne 0) { throw "Registration with $name failed. Fix the error and run this installer again." }
        Write-Host "creview registered with $name."
    }
    Write-Host "Restart $($hosts -join ' and '), then run /creview-config to configure presets."
}
