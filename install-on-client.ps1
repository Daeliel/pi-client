# Pull the latest pi-client, then install/update the Pi foundation package from this clone.
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\scripts\pi-client-install-lib.ps1"
Update-PiClientRepoClone
Sync-PiClientOnClient
