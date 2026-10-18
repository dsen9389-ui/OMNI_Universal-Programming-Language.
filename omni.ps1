param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $OmniArguments
)

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "OMNI needs Node.js 22 or 24 LTS. Install a supported Node.js release, then run this command again."
    exit 1
}

& $node.Source (Join-Path $PSScriptRoot "bin/omni.mjs") @OmniArguments
exit $LASTEXITCODE
