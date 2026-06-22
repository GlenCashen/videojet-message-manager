# create-vmm-tls.ps1
# Creates a private CA, agent client certificate, and server certificate for
# Videojet Message Manager printer-agent mTLS.
#
# Requires: PowerShell 7+.
#
# Example:
#   pwsh .\create-vmm-tls.ps1 `
#     -OutDir "C:\ProgramData\VideojetAgent\tls" `
#     -AgentId "packaging-agent-1" `
#     -ServerDns "vmm-agent.site.internal"

param(
  [string]$OutDir = "C:\ProgramData\VideojetAgent\tls",
  [string]$AgentId = "packaging-agent-1",
  [string]$ServerDns = "vmm-agent.site.internal",
  [int]$CaDays = 3650,
  [int]$CertDays = 825
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Require-PowerShell7 {
  if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw "This script requires PowerShell 7+. Install PowerShell 7 and run with: pwsh .\create-vmm-tls.ps1"
  }
}

function New-SerialNumber {
  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $bytes[0] = $bytes[0] -band 0x7F
  if (($bytes | Where-Object { $_ -ne 0 }).Count -eq 0) { $bytes[15] = 1 }
  return $bytes
}

function Write-TextFile {
  param(
    [string]$Path,
    [string]$Content
  )
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function New-KeyUsageExtension {
  param([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]$Flags)
  return [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($Flags, $true)
}

function New-EkuExtension {
  param([string[]]$Oids)
  $oidCollection = [System.Security.Cryptography.OidCollection]::new()
  foreach ($oid in $Oids) {
    [void]$oidCollection.Add([System.Security.Cryptography.Oid]::new($oid))
  }
  return [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oidCollection, $true)
}

function Export-CertAndKey {
  param(
    [System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert,
    [System.Security.Cryptography.RSA]$Key,
    [string]$CertPath,
    [string]$KeyPath
  )

  Write-TextFile -Path $CertPath -Content ($Cert.ExportCertificatePem() + [Environment]::NewLine)
  Write-TextFile -Path $KeyPath -Content ($Key.ExportPkcs8PrivateKeyPem() + [Environment]::NewLine)
}

Require-PowerShell7
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$now = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$caUntil = $now.AddDays($CaDays)
$certUntil = $now.AddDays($CertDays)

Write-Host "Creating TLS files in: $OutDir"
Write-Host "Agent ID: $AgentId"
Write-Host "Server DNS: $ServerDns"
Write-Host ""

# 1. Private CA
$caKey = [System.Security.Cryptography.RSA]::Create(4096)
$caSubject = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new("CN=Videojet Message Manager Agent CA")

$caReq = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  $caSubject,
  $caKey,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

$caReq.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
)
$caReq.CertificateExtensions.Add(
  (New-KeyUsageExtension -Flags (
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
  ))
)
$caReq.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caReq.PublicKey, $false)
)

$caCert = $caReq.CreateSelfSigned($now, $caUntil)

Write-TextFile -Path (Join-Path $OutDir "site-ca.pem") -Content ($caCert.ExportCertificatePem() + [Environment]::NewLine)
Write-TextFile -Path (Join-Path $OutDir "site-ca.key") -Content ($caKey.ExportPkcs8PrivateKeyPem() + [Environment]::NewLine)

# 2. Agent client certificate
$agentKey = [System.Security.Cryptography.RSA]::Create(2048)
$agentReq = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=$AgentId",
  $agentKey,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

$agentReq.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
)
$agentReq.CertificateExtensions.Add(
  (New-KeyUsageExtension -Flags (
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
  ))
)
# clientAuth = 1.3.6.1.5.5.7.3.2
$agentReq.CertificateExtensions.Add((New-EkuExtension -Oids @("1.3.6.1.5.5.7.3.2")))

$agentSan = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$agentSan.AddDnsName($AgentId)
$agentReq.CertificateExtensions.Add($agentSan.Build())

$agentCert = $agentReq.Create($caCert, $now, $certUntil, (New-SerialNumber))
Export-CertAndKey -Cert $agentCert -Key $agentKey `
  -CertPath (Join-Path $OutDir "agent.crt") `
  -KeyPath (Join-Path $OutDir "agent.key")

# 3. Server certificate for reverse proxy mTLS endpoint
$serverKey = [System.Security.Cryptography.RSA]::Create(2048)
$serverReq = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=$ServerDns",
  $serverKey,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

$serverReq.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
)
$serverReq.CertificateExtensions.Add(
  (New-KeyUsageExtension -Flags (
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
  ))
)
# serverAuth = 1.3.6.1.5.5.7.3.1
$serverReq.CertificateExtensions.Add((New-EkuExtension -Oids @("1.3.6.1.5.5.7.3.1")))

$serverSan = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$serverSan.AddDnsName($ServerDns)
$serverSan.AddDnsName("localhost")
$serverSan.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))
$serverReq.CertificateExtensions.Add($serverSan.Build())

$serverCert = $serverReq.Create($caCert, $now, $certUntil, (New-SerialNumber))
Export-CertAndKey -Cert $serverCert -Key $serverKey `
  -CertPath (Join-Path $OutDir "server.crt") `
  -KeyPath (Join-Path $OutDir "server.key")

# 4. Example env/nginx snippets
$agentEnv = @"
NODE_ENV=production
MAIN_SERVER_URL=https://$ServerDns
PRINTER_AGENT_ID=$AgentId
PRINTER_AGENT_TOKEN=replace-with-long-random-agent-token
PRINTER_AGENT_CONFIG=C:\ProgramData\VideojetAgent\printers.json
PRINTER_AGENT_STATE=C:\ProgramData\VideojetAgent\state.json
PRINTER_AGENT_CA_CERT=$OutDir\site-ca.pem
PRINTER_AGENT_CLIENT_CERT=$OutDir\agent.crt
PRINTER_AGENT_CLIENT_KEY=$OutDir\agent.key
PRINTER_AGENT_POLL_MS=2000
PRINTER_AGENT_HEARTBEAT_MS=15000
COMMAND_TIMEOUT_MS=5000
BETWEEN_COMMAND_DELAY_MS=150
"@

Write-TextFile -Path (Join-Path $OutDir ".env.agent.example") -Content ($agentEnv + [Environment]::NewLine)

$nginx = @"
server {
    listen 443 ssl;
    server_name $ServerDns;

    ssl_certificate     /etc/nginx/tls/server.crt;
    ssl_certificate_key /etc/nginx/tls/server.key;

    ssl_client_certificate /etc/nginx/tls/site-ca.pem;
    ssl_verify_client on;

    ssl_protocols TLSv1.2 TLSv1.3;

    location /api/printer-agent/ {
        proxy_set_header X-Client-Cert-Verified `$ssl_client_verify;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Host `$host;
        proxy_pass http://127.0.0.1:8080;
    }

    location / {
        return 404;
    }
}
"@

Write-TextFile -Path (Join-Path $OutDir "nginx-mtls-example.conf") -Content ($nginx + [Environment]::NewLine)

Write-Host "Created:"
Get-ChildItem $OutDir | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize

Write-Host ""
Write-Host "Agent files:"
Write-Host "  site-ca.pem"
Write-Host "  agent.crt"
Write-Host "  agent.key"
Write-Host ""
Write-Host "Reverse proxy files:"
Write-Host "  site-ca.pem"
Write-Host "  server.crt"
Write-Host "  server.key"
Write-Host ""
Write-Host "Keep private:"
Write-Host "  site-ca.key"
Write-Host "  agent.key"
Write-Host "  server.key"
Write-Host ""
Write-Host "Done."
