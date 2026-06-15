# Shipping to an Air-Gapped Environment

This guide explains how to package the MCP server on a machine that has internet
access, transfer it across the air gap, and set it up on the other side.

There are three options. Pick the one that fits your situation:

---

## Which option should I use?

```
Does every developer run their own copy, or will there be one shared server?
│
├── Every dev runs their own copy
│   └── → Option A: git bundle (per-dev, stdio mode)
│
└── One shared server for the whole team
    │
    ├── Is Docker available on the server?
    │   ├── Yes → Option B: Docker image transfer
    │   └── No  → Option C: git bundle (shared server, HTTP mode)
```

---

## Option A — Per-dev, each developer runs their own copy (git bundle)

**What the developer needs on their machine:** Node.js ≥ 20, Git.

**Transfer size:** ~3 MB (one `.bundle` file).

**Full setup guide:** [`setup-airgapped-tabnine.md`](setup-airgapped-tabnine.md)

### On the connected machine (do this once, or when there is an update):

```powershell
# 1. Clone and build
git clone https://github.com/izhaq/Azure-devOps-MCP.git
cd Azure-devOps-MCP
npm ci
npm run build

# 2. Make sure the built file is committed
#    (it already is on the fix/bundle-undici branch — skip if it shows clean)
git status

# 3. Create the bundle
git bundle create mcp-server.bundle --all
```

You now have one file: `mcp-server.bundle`. Transfer it across the air gap
(USB drive, internal file share, etc.).

### On the air-gapped machine:

```powershell
# Clone from the bundle — works exactly like cloning from a server
git clone C:\path\to\mcp-server.bundle azure-devops-mcp
```

Then follow the full guide: [`setup-airgapped-tabnine.md`](setup-airgapped-tabnine.md)
starting from Step 4 (create a PAT).

---

## Option B — Shared server with Docker (Docker image transfer)

**What the server machine needs:** Docker.

**What developers need on their machines:** nothing to install (they just point
their AI tool at a URL).

**Transfer size:** ~150 MB (one `.tar.gz` file for the Docker image, plus a
small `docker-compose.yml` text file).

**Full setup guide:** [`setup-shared-server.md`](setup-shared-server.md)

### On the connected machine (do this once, or when there is an update):

```powershell
# 1. Clone and build the Docker image
git clone https://github.com/izhaq/Azure-devOps-MCP.git
cd Azure-devOps-MCP
docker build -t azure-devops-mcp:latest .

# 2. Export the image to a single file
#    (gzip compression; reduces size by ~40%)
docker save azure-devops-mcp:latest | gzip > mcp-image.tar.gz
```

> **What is `docker save`?**
> It packages the entire Docker image — the app, its dependencies, the Node.js
> runtime, everything — into a single portable file. Think of it like a ZIP file
> for a virtual machine snapshot.

You now have one file: `mcp-image.tar.gz`. Transfer it across the air gap.

You also need the `docker-compose.yml` file (see below). This is a small text
file — you can copy it manually, transfer it alongside the image, or email it.

#### docker-compose.yml to use on the server

Save this as `docker-compose.yml` on the air-gapped server, then fill in your
Azure DevOps details:

```yaml
services:
  azure-devops-mcp:
    image: azure-devops-mcp:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      ADO_SERVER_URL: "https://azuredevops.yourcompany.local"
      ADO_COLLECTION: "YourCollection"
      ADO_API_VERSION: "7.1"
      ADO_ALLOWED_ORIGINS: "https://ado-mcp.yourcompany.local"
      ADO_LOG_LEVEL: "info"
```

### On the air-gapped server:

```bash
# 1. Load the image into Docker
docker load -i mcp-image.tar.gz
# Prints: Loaded image: azure-devops-mcp:latest

# 2. Confirm it is there
docker images azure-devops-mcp
# Should show the image with a size of ~200 MB

# 3. Start it
docker compose up -d

# 4. Check it is healthy
docker compose ps
# Should show: azure-devops-mcp   running (healthy)
```

Then continue from **Step 4** of [`setup-shared-server.md`](setup-shared-server.md)
(set up nginx for HTTPS).

### Updating to a new version

On the connected machine:
```powershell
cd Azure-devOps-MCP
git pull
docker build -t azure-devops-mcp:latest .
docker save azure-devops-mcp:latest | gzip > mcp-image.tar.gz
```

Transfer the new `mcp-image.tar.gz`. On the air-gapped server:
```bash
docker load -i mcp-image.tar.gz
docker compose up -d      # Docker replaces the old container automatically
```

Developers do not need to change anything — they keep using the same URL.

---

## Option C — Shared server without Docker (git bundle, HTTP mode)

Use this when Docker is not available on the server but you still want one
central server instead of every developer running their own copy.

**What the server machine needs:** Node.js ≥ 20, Git.

**Transfer size:** ~3 MB (same git bundle as Option A).

**The key difference from Option A:** the server runs in `--http` mode so
multiple developers can connect to it over the network, rather than each person
running their own copy in `--stdio` mode.

### On the connected machine (same as Option A):

```powershell
git clone https://github.com/izhaq/Azure-devOps-MCP.git
cd Azure-devOps-MCP
npm ci
npm run build
git bundle create mcp-server.bundle --all
```

Transfer `mcp-server.bundle` to the air-gapped **server machine**.

### On the air-gapped server:

```powershell
# Clone from the bundle
git clone C:\path\to\mcp-server.bundle C:\tools\azure-devops-mcp

# Set the server configuration (run once)
[Environment]::SetEnvironmentVariable("ADO_SERVER_URL",    "https://azuredevops.yourcompany.local", "Machine")
[Environment]::SetEnvironmentVariable("ADO_COLLECTION",    "YourCollection",                        "Machine")
[Environment]::SetEnvironmentVariable("ADO_API_VERSION",   "7.1",                                   "Machine")
[Environment]::SetEnvironmentVariable("ADO_HTTP_HOST",     "0.0.0.0",                               "Machine")
[Environment]::SetEnvironmentVariable("ADO_HTTP_PORT",     "3000",                                  "Machine")
[Environment]::SetEnvironmentVariable("NODE_TLS_REJECT_UNAUTHORIZED", "0",                          "Machine")
# Note: NO ADO_PAT here — each developer sends their own PAT per request
```

#### Keep it running — Windows Task Scheduler

The simplest way to keep the server running on a Windows machine without Docker
is Windows Task Scheduler. Run this **once** in an elevated (Administrator)
PowerShell to register the task:

```powershell
$action  = New-ScheduledTaskAction `
              -Execute "node.exe" `
              -Argument "C:\tools\azure-devops-mcp\dist\index.js --http" `
              -WorkingDirectory "C:\tools\azure-devops-mcp"

$trigger = New-ScheduledTaskTrigger -AtStartup

$settings = New-ScheduledTaskSettingsSet `
              -ExecutionTimeLimit ([TimeSpan]::Zero) `
              -RestartCount 3 `
              -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName   "AzureDevOps-MCP-Server" `
  -Action     $action `
  -Trigger    $trigger `
  -RunLevel   Highest `
  -Force

Start-ScheduledTask -TaskName "AzureDevOps-MCP-Server"
```

> **What does this do?**
> It registers a Windows scheduled task that starts the MCP server when the
> machine boots, and automatically restarts it (up to 3 times) if it crashes.
> This gives you similar behaviour to Docker's `restart: unless-stopped`, using
> only built-in Windows tools.

#### Keep it running — Linux systemd

If the server runs Linux, create `/etc/systemd/system/ado-mcp.service`:

```ini
[Unit]
Description=Azure DevOps MCP Server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/azure-devops-mcp/dist/index.js --http
WorkingDirectory=/opt/azure-devops-mcp
Restart=always
RestartSec=5
Environment=ADO_SERVER_URL=https://azuredevops.yourcompany.local
Environment=ADO_COLLECTION=YourCollection
Environment=ADO_API_VERSION=7.1
Environment=ADO_HTTP_HOST=0.0.0.0
Environment=ADO_HTTP_PORT=3000
Environment=NODE_TLS_REJECT_UNAUTHORIZED=0

[Install]
WantedBy=multi-user.target
```

Enable and start it:
```bash
sudo systemctl daemon-reload
sudo systemctl enable ado-mcp
sudo systemctl start ado-mcp
sudo systemctl status ado-mcp
```

#### HTTPS

Just like Option B, you need HTTPS so that PATs are not sent in plaintext.
Use the nginx config from [`setup-shared-server.md`](setup-shared-server.md)
Step 4 — it is identical regardless of whether the Node.js process runs inside
Docker or directly.

#### Updating to a new version

On the connected machine: create a new bundle as usual.

Transfer the bundle to the server, then:

```powershell
# Windows
cd C:\tools\azure-devops-mcp
git pull C:\path\to\new-mcp-server.bundle
Stop-ScheduledTask  -TaskName "AzureDevOps-MCP-Server"
Start-ScheduledTask -TaskName "AzureDevOps-MCP-Server"
```

```bash
# Linux
cd /opt/azure-devops-mcp
git pull /path/to/new-mcp-server.bundle
sudo systemctl restart ado-mcp
```

---

## Summary

| | Option A | Option B | Option C |
|---|---|---|---|
| **Who runs the server** | Each developer | Dedicated server | Dedicated server |
| **What you transfer** | `mcp-server.bundle` | `mcp-image.tar.gz` + `docker-compose.yml` | `mcp-server.bundle` |
| **Transfer size** | ~3 MB | ~150 MB | ~3 MB |
| **Server needs** | Node.js, Git | Docker | Node.js, Git |
| **Dev machines need** | Node.js, Git | Nothing (just a URL) | Nothing (just a URL) |
| **Mode** | `--stdio` | `--http` (Docker) | `--http` (direct) |
| **Per-user PAT** | In dev's local config | In `X-ADO-PAT` header | In `X-ADO-PAT` header |
| **Full setup guide** | [setup-airgapped-tabnine.md](setup-airgapped-tabnine.md) | [setup-shared-server.md](setup-shared-server.md) | [setup-shared-server.md](setup-shared-server.md) (skip Docker steps) |
