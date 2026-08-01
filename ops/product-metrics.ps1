[CmdletBinding()]
param(
    [switch]$Local
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SqlPath = Join-Path $PSScriptRoot "product-metrics.sql"
$Wrangler = Join-Path $RepoRoot "node_modules\.bin\wrangler.cmd"
$Target = if ($Local) { "--local" } else { "--remote" }
$Sql = (Get-Content $SqlPath) -join " "

$Output = & $Wrangler d1 execute heya-to $Target --json --command $Sql
if ($LASTEXITCODE -ne 0) {
    throw "D1 metrics query failed with exit code $LASTEXITCODE"
}

$Payload = ($Output -join [Environment]::NewLine) | ConvertFrom-Json
$Row = $Payload[0].results[0]
if (-not $Row) {
    throw "D1 metrics query returned no result"
}

function Get-Percent {
    param([int]$Numerator, [int]$Denominator)
    if ($Denominator -eq 0) { return $null }
    return [Math]::Round(($Numerator / $Denominator) * 100, 1)
}

$Users = [int]$Row.users
$Creators = [int]$Row.creators
$Copiers = [int]$Row.copiers
$Entrants = [int]$Row.entrants

[ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    service = "heya-to"
    environment = if ($Local) { "local" } else { "production" }
    funnel = [ordered]@{
        users = $Users
        creators = $Creators
        copiers = $Copiers
        rooms_copied = [int]$Row.rooms_copied
        entrants = $Entrants
        rooms_entered = [int]$Row.rooms_entered
        filters = [int]$Row.filters
        managers = [int]$Row.managers
        returned = [int]$Row.returned
        created_7d = [int]$Row.created_7d
        copiers_7d = [int]$Row.copiers_7d
        qa_rows = [int]$Row.qa_rows
    }
    live_state = [ordered]@{
        active_rooms = [int]$Row.active_rooms
        full_rooms = [int]$Row.full_rooms
        closed_rooms = [int]$Row.closed_rooms
        hidden_rooms = [int]$Row.hidden_rooms
        entered_signals = [int]$Row.entered_signals
        full_signals = [int]$Row.full_signals
        reports = [int]$Row.reports
    }
    rates = [ordered]@{
        creator_percent = Get-Percent $Creators $Users
        copier_percent = Get-Percent $Copiers $Users
        entrant_percent = Get-Percent $Entrants $Copiers
        return_percent = Get-Percent ([int]$Row.returned) $Users
    }
} | ConvertTo-Json -Depth 4
