[CmdletBinding()]
param(
	[string]$Repo,
	[string]$Token = $env:GITHUB_TOKEN,
	[string]$IssuesDir,
	[string[]]$IssueFiles,
	[switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($IssuesDir)) {
	$IssuesDir = Split-Path -Parent $PSCommandPath
}

function Get-DefaultRepo {
	$originUrl = git remote get-url origin 2>$null
	if (-not $originUrl) {
		throw "Could not infer -Repo from git remote origin. Pass -Repo owner/name explicitly."
	}

	if ($originUrl -match 'github\.com[:/](?<repo>[^/]+/[^/.]+)(?:\.git)?$') {
		return $Matches.repo
	}

	throw "Could not parse a GitHub owner/repo from origin URL: $originUrl"
}

function Normalize-LabelName {
	param([string]$Value)
	return (($Value -replace '[`"]', '').Trim())
}

function Parse-CommaList {
	param([string]$Value)
	if ([string]::IsNullOrWhiteSpace($Value) -or $Value -eq "none") {
		return @()
	}
	return @(
		$Value.Split(",") |
			ForEach-Object { Normalize-LabelName $_ } |
			Where-Object { $_ }
	)
}

function Parse-IssueFile {
	param([string]$Path)

	$raw = Get-Content -Raw -LiteralPath $Path
	$lines = $raw -split "`r?`n"
	$titleLine = $lines | Where-Object { $_ -match '^# ' } | Select-Object -First 1
	if (-not $titleLine) {
		throw "Missing top-level title in $Path"
	}

	$title = $titleLine -replace '^#\s*', ''
	$id = if ($title -match '^(?<id>ER-\d+):') { $Matches.id } else { [IO.Path]::GetFileNameWithoutExtension($Path) }

	$metadata = [ordered]@{
		Type       = $null
		Priority   = $null
		Milestone  = $null
		PRWave     = $null
		Labels     = @()
		DependsOn  = @()
		Blocks     = @()
	}

	$inMetadata = $false
	foreach ($line in $lines) {
		if ($line -eq '## Suggested metadata') {
			$inMetadata = $true
			continue
		}
		if ($inMetadata -and $line -match '^## ') {
			break
		}
		if (-not $inMetadata) {
			continue
		}
		if ($line -match '^- Type:\s*(.+)$') {
			$metadata.Type = $Matches[1].Trim()
			continue
		}
		if ($line -match '^- Priority:\s*(.+)$') {
			$metadata.Priority = $Matches[1].Trim()
			continue
		}
		if ($line -match '^- Milestone:\s*(.+)$') {
			$metadata.Milestone = $Matches[1].Trim()
			continue
		}
		if ($line -match '^- PR wave:\s*(.+)$') {
			$metadata.PRWave = $Matches[1].Trim()
			continue
		}
		if ($line -match '^- Labels:\s*(.+)$') {
			$metadata.Labels = @(Parse-CommaList $Matches[1])
			continue
		}
		if ($line -match '^- Depends on:\s*(.+)$') {
			$metadata.DependsOn = @(Parse-CommaList $Matches[1])
			continue
		}
		if ($line -match '^- Blocks:\s*(.+)$') {
			$metadata.Blocks = @(Parse-CommaList $Matches[1])
			continue
		}
	}

	$summaryIndex = [Array]::IndexOf($lines, '## Summary')
	if ($summaryIndex -lt 0) {
		throw "Missing '## Summary' section in $Path"
	}

	$bodyCore = ($lines[$summaryIndex..($lines.Length - 1)] -join "`n").Trim()
	$bodyLines = @(
		$bodyCore
		""
		"---"
		""
		"## Imported metadata"
		""
		"- Local ID: $id"
		"- Type: $($metadata.Type)"
		"- Priority: $($metadata.Priority)"
		"- Milestone: $($metadata.Milestone)"
		"- PR wave: $($metadata.PRWave)"
		"- Depends on: $(if ($metadata.DependsOn.Count -gt 0) { $metadata.DependsOn -join ', ' } else { 'none' })"
		"- Blocks: $(if ($metadata.Blocks.Count -gt 0) { $metadata.Blocks -join ', ' } else { 'none' })"
		"- Source file: assets/issues/$([IO.Path]::GetFileName($Path))"
	)
	$body = ($bodyLines -join "`n").Trim()

	[pscustomobject]@{
		Id        = $id
		Title     = $title
		Path      = $Path
		Body      = $body
		Metadata  = [pscustomobject]$metadata
	}
}

function Get-DefaultLabelColor {
	param([string]$Label)

	if ($Label -like 'area:*') { return '0e8a16' }
	if ($Label -like 'risk:*') { return 'b60205' }
	if ($Label -like 'blocks:*') { return '5319e7' }
	return '1d76db'
}

function Get-GitHubHeaders {
	param([string]$ApiToken)
	return @{
		Authorization         = "Bearer $ApiToken"
		Accept                = "application/vnd.github+json"
		"X-GitHub-Api-Version" = "2022-11-28"
	}
}

function Invoke-GitHubJson {
	param(
		[string]$Method,
		[string]$Uri,
		[hashtable]$Headers,
		[object]$Body
	)

	if ($null -eq $Body) {
		return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers
	}

	$json = $Body | ConvertTo-Json -Depth 20
	return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -ContentType "application/json" -Body $json
}

function Ensure-GitHubLabel {
	param(
		[string]$RepoName,
		[string]$Label,
		[hashtable]$Headers
	)

	$encoded = [uri]::EscapeDataString($Label)
	$uri = "https://api.github.com/repos/$RepoName/labels/$encoded"
	try {
		$null = Invoke-GitHubJson -Method GET -Uri $uri -Headers $Headers -Body $null
		return
	} catch {
		$response = $_.Exception.Response
		if ($null -eq $response -or [int]$response.StatusCode -ne 404) {
			throw
		}
	}

	$createUri = "https://api.github.com/repos/$RepoName/labels"
	$payload = @{
		name  = $Label
		color = Get-DefaultLabelColor $Label
	}
	try {
		$null = Invoke-GitHubJson -Method POST -Uri $createUri -Headers $Headers -Body $payload
	} catch {
		$response = $_.Exception.Response
		if ($null -ne $response -and [int]$response.StatusCode -eq 422) {
			return
		}
		throw
	}
}

function Ensure-GitHubMilestone {
	param(
		[string]$RepoName,
		[string]$MilestoneTitle,
		[hashtable]$Headers
	)

	if ([string]::IsNullOrWhiteSpace($MilestoneTitle) -or $MilestoneTitle -eq "none") {
		return $null
	}

	function Find-MilestoneNumber {
		param(
			[string]$SearchRepoName,
			[string]$SearchMilestoneTitle,
			[hashtable]$SearchHeaders
		)

		$searchUri = "https://api.github.com/repos/$SearchRepoName/milestones?state=all&per_page=100"
		$searchExistingRaw = Invoke-GitHubJson -Method GET -Uri $searchUri -Headers $SearchHeaders -Body $null
		$searchExisting = @()
		foreach ($entry in @($searchExistingRaw)) {
			if ($entry -is [System.Array]) {
				$searchExisting += @($entry)
			} else {
				$searchExisting += $entry
			}
		}
		$searchMatch = $searchExisting |
			Where-Object {
				$_.PSObject.Properties.Match("title").Count -gt 0 -and
				$_.PSObject.Properties.Match("number").Count -gt 0 -and
				$_.title -eq $SearchMilestoneTitle
			} |
			Select-Object -First 1
		if ($searchMatch) {
			return [int]$searchMatch.number
		}
		return $null
	}

	$existingNumber = Find-MilestoneNumber -SearchRepoName $RepoName -SearchMilestoneTitle $MilestoneTitle -SearchHeaders $Headers
	if ($null -ne $existingNumber) {
		return $existingNumber
	}

	$createUri = "https://api.github.com/repos/$RepoName/milestones"
	try {
		$created = Invoke-GitHubJson -Method POST -Uri $createUri -Headers $Headers -Body @{ title = $MilestoneTitle }
	} catch {
		$response = $_.Exception.Response
		if ($null -ne $response -and [int]$response.StatusCode -eq 422) {
			$existingNumber = Find-MilestoneNumber -SearchRepoName $RepoName -SearchMilestoneTitle $MilestoneTitle -SearchHeaders $Headers
			if ($null -ne $existingNumber) {
				return $existingNumber
			}
		}
		throw
	}
	return [int]$created.number
}

if (-not $Repo) {
	$Repo = Get-DefaultRepo
}

$issuePaths = @(
	if ($IssueFiles -and $IssueFiles.Count -gt 0) {
		$IssueFiles | ForEach-Object {
			if ([IO.Path]::IsPathRooted($_)) { $_ } else { Join-Path $IssuesDir $_ }
		}
	} else {
		Get-ChildItem -LiteralPath $IssuesDir -Filter 'ISSUE-*.md' |
			Sort-Object Name |
			ForEach-Object FullName
	}
)

if ($issuePaths.Count -eq 0) {
	throw "No issue files found in $IssuesDir"
}

$issues = @($issuePaths | ForEach-Object { Parse-IssueFile $_ })

if ($DryRun) {
	Write-Host "Dry run for repo $Repo"
	foreach ($issue in $issues) {
		Write-Host ""
		Write-Host "[$($issue.Id)] $($issue.Title)"
		Write-Host "  milestone: $($issue.Metadata.Milestone)"
		Write-Host "  labels:    $((@($issue.Metadata.Labels) -join ', '))"
		Write-Host "  depends:   $((@($issue.Metadata.DependsOn) -join ', '))"
		Write-Host "  blocks:    $((@($issue.Metadata.Blocks) -join ', '))"
	}
	exit 0
}

if ([string]::IsNullOrWhiteSpace($Token)) {
	throw "Missing GitHub token. Set GITHUB_TOKEN or pass -Token."
}

$headers = Get-GitHubHeaders $Token

$allLabels = @(
	$issues |
		ForEach-Object { @($_.Metadata.Labels) } |
		Where-Object { $_ } |
		Sort-Object -Unique
)

foreach ($label in $allLabels) {
	Ensure-GitHubLabel -RepoName $Repo -Label $label -Headers $headers
}

$milestoneMap = @{}
foreach ($milestoneTitle in ($issues | ForEach-Object { $_.Metadata.Milestone } | Where-Object { $_ } | Sort-Object -Unique)) {
	$milestoneMap[$milestoneTitle] = Ensure-GitHubMilestone -RepoName $Repo -MilestoneTitle $milestoneTitle -Headers $headers
}

$results = @()
foreach ($issue in $issues) {
	$payload = @{
		title  = $issue.Title
		body   = $issue.Body
		labels = @($issue.Metadata.Labels)
	}
	if ($issue.Metadata.Milestone -and $milestoneMap.ContainsKey($issue.Metadata.Milestone)) {
		$payload.milestone = $milestoneMap[$issue.Metadata.Milestone]
	}

	$created = Invoke-GitHubJson -Method POST -Uri "https://api.github.com/repos/$Repo/issues" -Headers $headers -Body $payload
	$result = [pscustomobject]@{
		localId      = $issue.Id
		title        = $issue.Title
		number       = [int]$created.number
		url          = [string]$created.html_url
		milestone    = $issue.Metadata.Milestone
		labels       = @($issue.Metadata.Labels)
		dependsOn    = @($issue.Metadata.DependsOn)
		blocks       = @($issue.Metadata.Blocks)
		sourceFile   = [IO.Path]::GetFileName($issue.Path)
	}
	$results += $result
	Write-Host "Created #$($result.number) $($result.localId) -> $($result.url)"
}

$resultPath = Join-Path $IssuesDir 'github-import-result.json'
$results | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resultPath -Encoding utf8
Write-Host ""
Write-Host "Import complete. Result map written to $resultPath"
