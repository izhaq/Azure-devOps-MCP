# Setting up Azure DevOps MCP in an Air-Gapped Environment (Tabnine CLI)

This guide walks you through setting up the Azure DevOps MCP server step by step.
It is written for someone who is not a Node.js or infrastructure expert.

**What this does:** once set up, Tabnine CLI will be able to talk to your on-premises
Azure DevOps Server — read projects, work items, repositories, pipelines, wikis, and
more — without any internet connection.

---

## Before you start — what you need

| Thing | Why you need it |
|---|---|
| A **Windows machine inside the air-gapped network** | Where Tabnine will run |
| A **Windows or Linux machine with internet access** | One-time build step only |
| **Node.js ≥ 20** installed on **both** machines | Runs the MCP server |
| **Git** installed on **both** machines | To clone the repo and create/receive the bundle |
| Access to `https://azuredevops.rafael.co.il` from the air-gapped machine | To actually talk to ADO |
| A **Personal Access Token (PAT)** from Azure DevOps | Your login credential for the server |
| **Tabnine CLI** installed and working | The AI client |

> **What is a PAT?**
> A Personal Access Token is like a password that only works for one specific application.
> You create it inside Azure DevOps, give it limited permissions, and it lets the MCP server
> log in on your behalf. You can revoke it at any time.

---

## Step 1 — Build the project on a connected machine (one time only)

Do this on a machine that has internet access. You only ever need to do this once,
or whenever there is an update to the MCP server.

Open a terminal (PowerShell or CMD) and run:

```powershell
# Download the project
git clone https://github.com/izhaq/Azure-devOps-MCP.git
cd Azure-devOps-MCP

# Download all dependencies (needs internet)
npm ci

# Build the server into a single self-contained file
npm run build
```

When this finishes you will have `dist\index.js` — a single file that contains the
MCP server and all its dependencies bundled together. This is the only file you need
to run the server; `node_modules\` is not required at runtime.

---

## Step 2 — Create a git bundle and transfer it

A **git bundle** is a single file that contains the entire repository — including
`dist\index.js` — that you can carry across the air gap.

**On the connected machine**, inside the `Azure-devOps-MCP` folder:

```powershell
# Create the bundle file
git bundle create mcp-server.bundle --all
```

This creates `mcp-server.bundle` (a single file, roughly 2–3 MB).
Transfer it to the air-gapped machine using whatever method your organisation uses
(USB drive, internal file share, etc.).

---

## Step 3 — Clone the bundle on the air-gapped machine

On the **air-gapped machine**, open a terminal and run:

```powershell
# Clone from the bundle — works exactly like cloning from a server
git clone C:\path\to\mcp-server.bundle azure-devops-mcp
```

Replace `C:\path\to\mcp-server.bundle` with wherever you put the bundle file.

You now have an `azure-devops-mcp` folder. Place it somewhere stable, for example:

```
C:\tools\azure-devops-mcp\
```

> Write down the full path — you will need it in Step 6.

That folder contains `dist\index.js`. That single file is the entire MCP server.
No internet, no npm, no `node_modules` required.

---

## Step 4 — Create a Personal Access Token (PAT) in Azure DevOps

1. Open your browser and go to:
   ```
   https://azuredevops.rafael.co.il/Air_and_Modiin_Collection/_usersSettings/tokens
   ```
2. Click **New Token**.
3. Give it a name, e.g. `tabnine-mcp`.
4. Set **Expiration** to whatever your security policy allows (e.g. 90 days).
5. Under **Scopes**, select **Custom defined** and tick at minimum:
   - **Code** → Read
   - **Work Items** → Read (and Write if you want to create/update work items)
6. Click **Create**.
7. **Copy the token immediately** — you will never see it again after closing this dialog.

---

## Step 5 — Set up environment variables

The MCP server needs to know your Azure DevOps server address and your PAT.
The safest way is to set these as **user environment variables** on Windows,
so they are always available to any tool you run.

Save the script below as `setup-env.ps1` somewhere on your machine, open it in
Notepad, fill in your PAT, then run it **once** in PowerShell:

```powershell
# setup-env.ps1
# Run this once to permanently save the MCP server settings for your user account.
# Replace <YOUR-PAT-HERE> with the token you copied from Azure DevOps.

$pat = "<YOUR-PAT-HERE>"   # ← paste your PAT here

[Environment]::SetEnvironmentVariable("ADO_SERVER_URL",               "https://azuredevops.rafael.co.il", "User")
[Environment]::SetEnvironmentVariable("ADO_COLLECTION",               "Air_and_Modiin_Collection",        "User")
[Environment]::SetEnvironmentVariable("ADO_PAT",                      $pat,                               "User")
[Environment]::SetEnvironmentVariable("ADO_API_VERSION",              "7.1",                              "User")
[Environment]::SetEnvironmentVariable("NODE_TLS_REJECT_UNAUTHORIZED", "0",                                "User")

Write-Host "Done. Close and reopen your terminal for the changes to take effect."
```

> **What is `NODE_TLS_REJECT_UNAUTHORIZED=0`?**
> Your Azure DevOps server uses a certificate from an internal company CA that
> Node.js does not trust by default. Setting this to `0` tells Node.js to skip
> certificate verification when talking to the server. This is acceptable inside
> your private corporate network because you control both ends of the connection.
> Never use this setting on a public internet server.

After running the script, **close and reopen your terminal** so the new variables load.

---

## Step 6 — Test the connection

Before wiring up Tabnine, verify the MCP server can actually reach Azure DevOps.

Save this script as `test-mcp.ps1` anywhere on the air-gapped machine, then run it:

```powershell
# test-mcp.ps1
# Sends a real request to your Azure DevOps server and prints the result.

$serverPath = "C:\tools\azure-devops-mcp\dist\index.js"   # ← update this path

$payload = @(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
    '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"core_list_projects","arguments":{}}}'
) -join "`n"

$payload | node $serverPath --stdio 2>$null | Where-Object { $_ -match '"id":2' }
```

Run it:
```powershell
.\test-mcp.ps1
```

**Success looks like** — a JSON line containing your project names:
```json
{"result":{"content":[{"type":"text","text":"[{\"name\":\"aeroSpike\",...}]"}]},"jsonrpc":"2.0","id":2}
```

**If you see `fetch failed`** → go to the Troubleshooting section at the end of this guide.

**If you see `Unauthorized`** → your PAT is wrong or expired. Re-create it in Step 4.

---

## Step 7 — Configure Tabnine CLI

Tabnine CLI reads its MCP server list from a JSON file. You need to create or edit
that file to add the Azure DevOps server.

**File location:**
- **Global (all projects):** `%USERPROFILE%\.tabnine\mcp_servers.json`
- **Per project:** `.tabnine\mcp_servers.json` inside your project folder

Open (or create) the file and add this — replacing the path with your actual install location:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "node",
      "args": [
        "C:\\tools\\azure-devops-mcp\\dist\\index.js",
        "--stdio"
      ],
      "env": {
        "ADO_SERVER_URL": "https://azuredevops.rafael.co.il",
        "ADO_COLLECTION": "Air_and_Modiin_Collection",
        "ADO_PAT": "<YOUR-PAT-HERE>",
        "ADO_API_VERSION": "7.1",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

> **Why repeat the env vars here if I already set them in Step 5?**
> Some AI clients launch the MCP server as a child process that does not inherit
> your user environment variables. Putting them in the config file guarantees
> the server always has them regardless of how it is launched.

Save the file, then **restart Tabnine CLI**.

---

## Step 8 — Verify Tabnine can use the tools

After restarting Tabnine CLI, try asking it something that requires Azure DevOps data, for example:

> *"List the projects in our Azure DevOps collection"*

> *"Show me the open pull requests in the aeroSpike project"*

> *"What work items are assigned to me?"*

If Tabnine responds with real data from your Azure DevOps — you are done.

---

## What tools are available

Once connected, Tabnine can use all of these:

| Area | What you can do |
|---|---|
| **Projects & Teams** | List projects, list teams |
| **Work Items** | Query (WIQL), get, create, update, add comments |
| **Repositories** | List repos, branches, files, commits |
| **Pull Requests** | List, get, create, comment, change status |
| **Pipelines & Builds** | List pipelines, get builds, queue a build, get logs |
| **Boards / Iterations** | List sprints, backlog levels, team capacity |
| **Wiki** | List wikis, read pages, create/edit pages |
| **Test Plans** | List plans, suites, test cases |

---

## Troubleshooting

### `fetch failed`

The MCP server started but could not reach Azure DevOps. Check:

1. **Can your browser reach** `https://azuredevops.rafael.co.il`? If no → network issue, talk to IT.
2. **Are the environment variables set?** Open a new terminal and run:
   ```powershell
   echo $env:ADO_SERVER_URL
   ```
   If it prints nothing → the variables from Step 5 did not load. Close the terminal and reopen it.
3. **Is Node.js version ≥ 20?**
   ```powershell
   node --version
   ```

### `Unauthorized` / `TF400813`

Your PAT is wrong, expired, or has insufficient scope. Re-create it in Step 4,
making sure to tick **Code → Read** and **Work Items → Read**.

### Tabnine does not show Azure DevOps tools

- Confirm the path in the Tabnine config file (`mcp_servers.json`) is correct and uses double backslashes (`\\`).
- Confirm the file is valid JSON (paste it into [jsonlint.com](https://jsonlint.com) on a connected machine if unsure).
- Restart Tabnine CLI after editing the file.

---

## Updating the server in future

When a new version of the MCP server is available, do the same steps you did the
first time — on the connected machine:

```powershell
cd Azure-devOps-MCP
git pull
npm ci
npm run build
git bundle create mcp-server.bundle --all
```

Transfer `mcp-server.bundle` to the air-gapped machine and run:

```powershell
# Pull the new version into the existing folder
cd C:\tools\azure-devops-mcp
git pull C:\path\to\mcp-server.bundle
```

Restart Tabnine CLI — no config changes needed.
