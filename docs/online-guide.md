# Preparing the MCP server for an air-gapped environment

This guide is for the person on the **connected (internet-facing) machine** who
needs to package the server and hand it off to the air-gapped side.

The air-gapped machine does not need internet access once the transfer is done.

---

## What you need on the connected machine

- Git
- Node.js ≥ 20
- Access to the source repository:
  `https://github.com/izhaq/Azure-devOps-MCP`

---

## Step 1 — Clone and verify the build

```powershell
git clone https://github.com/izhaq/Azure-devOps-MCP.git
cd Azure-devOps-MCP
```

The repository already contains a pre-built `dist/index.js` — **no build step is
needed.** Confirm it is there:

```powershell
Test-Path dist\index.js   # should print: True
```

---

## Step 2 — Transfer to the air-gapped environment

Choose the option that fits your situation. Only **Option A** is currently
supported end-to-end. Options B and C are planned for a future release.

---

### Option A — Transfer `dist/index.js` only ✅ (currently supported)

The single compiled file is all that is needed to run the server. It contains
the full application with no external dependencies.

**Transfer size:** ~1 MB

1. Copy `dist/index.js` to the air-gapped machine (USB drive, internal file
   share, etc.).
2. Continue with the air-gapped setup: **[Option A in the offline guide](offline-guide.md#option-a--run-distindexjs-directly-per-developer-stdio)**

---

### Option B — Transfer the full repository (git bundle) 🔜 (supported in the future)

Transfers the entire repository including source code, scripts, and docs.
Useful when you want the setup scripts (`scripts/setup-env.ps1`,
`scripts/test-connection.ps1`) to be available on the air-gapped machine.

**Transfer size:** ~3 MB

```powershell
git bundle create azure-devops-mcp.bundle --all
```

Copy `azure-devops-mcp.bundle` to the air-gapped machine, then continue with:
**[Option B in the offline guide](offline-guide.md#option-b--clone-from-a-git-bundle)**

---

### Option C — Transfer a Docker image 🔜 (supported in the future)

For teams that want a single shared server instead of every developer running
their own copy. Requires Docker on the air-gapped server machine.

**Transfer size:** ~150 MB

```powershell
docker build -t azure-devops-mcp:latest .
docker save azure-devops-mcp:latest | gzip > azure-devops-mcp-image.tar.gz
```

Copy `azure-devops-mcp-image.tar.gz` to the air-gapped server, then continue
with: **[Option C in the offline guide](offline-guide.md#option-c--shared-server-with-docker)**

---

## Updating to a new version

When a new version is available, pull the latest code and repeat Step 2 with
the same option you used the first time:

```powershell
cd Azure-devOps-MCP
git pull
```

Then transfer the updated file(s) and re-run the relevant install step on the
air-gapped machine.
