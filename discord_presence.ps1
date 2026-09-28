# D4Hz — Discord Desktop Rich Presence with DEATH.gif
param(
    [string]$Action = "start",
    [string]$Details = "D4Hz WEB - High Frequency Audio",
    [string]$State = "Voice Amplifier Active ⚡",
    [string]$ImageUrl = "https://files.catbox.moe/fi131s.gif",
    [string]$ClientId = "383226320970055681",
    [string]$FallbackClientId = "1344697306231935048",
    [switch]$Daemon,
    [switch]$Once
)

function Write-Packet($stream, [int]$opcode, [string]$json) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $writer = New-Object System.IO.BinaryWriter($stream)
    $writer.Write([int]$opcode)
    $writer.Write([int]$bytes.Length)
    $writer.Write($bytes)
    $writer.Flush()
}

function Read-Packet($stream) {
    $reader = New-Object System.IO.BinaryReader($stream)
    $op = $reader.ReadInt32()
    $len = $reader.ReadInt32()
    $bytes = $reader.ReadBytes($len)
    $json = [System.Text.Encoding]::UTF8.GetString($bytes)
    return @{ Opcode = $op; Json = $json }
}

function Find-DiscordPipe([int]$timeoutMs = 600, [int]$retries = 3) {
    for ($attempt = 1; $attempt -le $retries; $attempt++) {
        for ($i = 0; $i -lt 10; $i++) {
            try {
                $p = New-Object System.IO.Pipes.NamedPipeClientStream(".", "discord-ipc-$i", [System.IO.Pipes.PipeDirection]::InOut)
                $p.Connect($timeoutMs)
                if ($p.IsConnected) {
                    Write-Host "[D4Hz RPC] Connected to named pipe: discord-ipc-$i" -ForegroundColor Cyan
                    return $p
                }
            } catch {}
        }
        if ($attempt -lt $retries) {
            Start-Sleep -Milliseconds 400
        }
    }
    return $null
}

$pipe = Find-DiscordPipe

if (-not $pipe) {
    Write-Host "[D4Hz RPC] Discord Desktop client is not running or named pipe not found." -ForegroundColor Yellow
    Write-Host "[D4Hz RPC] Please open the Discord Desktop app to show Rich Presence on your profile." -ForegroundColor Gray
    exit 1
}

# 1. Send Handshake with primary ClientId, fallback if needed
$activeClientId = $ClientId
$handshake = '{"v":1,"client_id":"' + $activeClientId + '"}'
Write-Packet $pipe 0 $handshake
$readyRes = Read-Packet $pipe

if ($readyRes.Json -match '"code":4000' -or $readyRes.Json -match 'error') {
    Write-Host "[D4Hz RPC] Primary Client ID ($activeClientId) not accepted, trying fallback ($FallbackClientId)..." -ForegroundColor Yellow
    $pipe.Close()
    Start-Sleep -Milliseconds 300
    $pipe = Find-DiscordPipe
    if ($pipe) {
        $activeClientId = $FallbackClientId
        $handshake = '{"v":1,"client_id":"' + $activeClientId + '"}'
        Write-Packet $pipe 0 $handshake
        $readyRes = Read-Packet $pipe
    }
}

Write-Host "[D4Hz RPC] Handshake OK (App ID: $activeClientId)!" -ForegroundColor Green

# 2. Send SET_ACTIVITY with DEATH.gif
$startTime = [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
$activityObj = @{
    cmd = "SET_ACTIVITY"
    args = @{
        pid = $PID
        activity = @{
            state = $State
            details = $Details
            timestamps = @{
                start = $startTime
            }
            assets = @{
                large_image = $ImageUrl
                large_text = "D4Hz - DEATH"
                small_image = $ImageUrl
                small_text = "D4Hz WEB"
            }
            buttons = @(
                @{ label = "D4Hz"; url = "https://github.com" }
            )
        }
    }
    nonce = [Guid]::NewGuid().ToString()
}

$actJson = ConvertTo-Json -InputObject $activityObj -Depth 6 -Compress
Write-Packet $pipe 1 $actJson
$actRes = Read-Packet $pipe
Write-Host "[D4Hz RPC] Discord Profile Activity Updated with DEATH.gif! 🎮" -ForegroundColor Green

if ($Once) {
    Write-Host "[D4Hz RPC] Sent once. Closing pipe." -ForegroundColor DarkGray
    Start-Sleep -Seconds 1
    $pipe.Close()
} else {
    Write-Host "[D4Hz RPC] Rich Presence is active on your profile! (Press Ctrl+C to stop)" -ForegroundColor DarkCyan
    try {
        while ($pipe.IsConnected) {
            Start-Sleep -Seconds 5
        }
    } finally {
        $pipe.Close()
        Write-Host "[D4Hz RPC] Pipe closed. Presence cleared." -ForegroundColor Gray
    }
}
