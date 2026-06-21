# Installing the MCP server in an air-gapped environment

This guide is for the **air-gapped (offline) machine**. It assumes the server
files have already been transferred from the connected side.

If you have not done that yet, start with the
[online guide](online-guide.md) first.

---

## Option A — Run `dist/index.js` directly (per-developer, stdio) ✅ (currently supported)

Each developer runs their own local copy of the server. The AI tool (Tabnine,
Claude Code, etc.) starts it automatically in the background — you will never
need to start it manually.

**What you need:** Node.js ≥ 20, and the `dist/index.js` file.

---

### Step 1 — Get the file

The project is available in the internal repository. Clone it to your machine:

```powershell
git clone <internal-repo-url> azure-devops-mcp
```

Or, if you only have the single file, copy `dist/index.js` to a permanent
location, for example:

```
C:\tools\azure-devops-mcp\dist\index.js
```

Note the full path — you will need it in Step 3.

---

### Step 2 — Set up environment variables

The server is configured entirely through environment variables (your Azure
DevOps URL, collection, API version, and PAT).

Run the setup script. It will prompt you for each value and save them
permanently to your Windows user account:

```powershell
.\scripts\setup-env.ps1
```

> If you only have `dist/index.js` and not the scripts folder, set the
> variables manually — see the [manual setup](#manual-environment-setup)
> section at the bottom of this guide.

**What the script asks for:**

| Prompt | What to enter | Example |
|---|---|---|
| Azure DevOps Server URL | Your server address (no trailing slash) | `http://devdev:3040/tfs` |
| Collection name | Your ADO collection | `DefaultCollection` |
| API version | Press Enter to accept `7.1` (correct for most servers) | `7.1` |
| PAT | Your Personal Access Token (input is hidden) | _(paste your PAT)_ |

> **Where to find each value:**
> - **Server URL + Collection**: visible in the browser address bar when you
>   open Azure DevOps. Example: `http://devdev:3040/tfs/MyCollection` →
>   URL is `http://devdev:3040/tfs`, collection is `MyCollection`.
> - **API version**: press Enter to accept the default `7.1`. If the connection
>   test fails with an API version error, try `6.0` or `5.1`.
> - **PAT**: create one at `<your-server-url>/<collection>/_usersSettings/tokens`.
>   Give it at minimum **Code → Read** and **Work Items → Read** scope.
>   Copy it immediately — you cannot see it again after closing the dialog.

---

### Step 3 — Configure your AI tool

Tell your AI tool where to find the server. The exact config file location
depends on the tool you use.

#### Tabnine

Open (or create) `C:\Users\<YourName>\.tabnine\mcp_servers.json` and add:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "node",
      "args": ["C:\\tools\\azure-devops-mcp\\dist\\index.js", "--stdio"],
      "env": {
        "ADO_SERVER_URL": "<your-server-url>",
        "ADO_COLLECTION": "<your-collection>",
        "ADO_API_VERSION": "7.1",
        "ADO_PAT": "<your-pat>",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

Replace the path in `args` with the actual full path to `dist/index.js` on
your machine.

Restart Tabnine after saving.

#### Claude Code

```powershell
claude mcp add azure-devops --command node -- C:\tools\azure-devops-mcp\dist\index.js --stdio
```

Then open `C:\Users\<YourName>\.claude.json` and add the environment variables
under the `azure-devops` entry:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "node",
      "args": ["C:\\tools\\azure-devops-mcp\\dist\\index.js", "--stdio"],
      "env": {
        "ADO_SERVER_URL": "<your-server-url>",
        "ADO_COLLECTION": "<your-collection>",
        "ADO_API_VERSION": "7.1",
        "ADO_PAT": "<your-pat>",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

Restart Claude Code after saving.

---

### Step 4 — Test the connection

Run the test script to confirm everything works before you try it in your AI
tool:

```powershell
.\scripts\test-connection.ps1
```

A successful run prints:

```
SUCCESS  Connected to Azure DevOps!

Projects in 'MyCollection':
  - ProjectA
  - ProjectB
```

If it fails, the script prints a clear error message with the next step to try.

**Common fixes:**

| Error | Fix |
|---|---|
| `ADO_SERVER_URL is not set` | Run `setup-env.ps1` again, or open a new terminal window |
| `No response received` | Open `<server-url>` in a browser to confirm network access |
| `Unauthorized` | PAT is wrong, expired, or missing scope — create a new one |
| API version error | Re-run `setup-env.ps1` and enter `6.0` or `5.1` instead of `7.1` |

---

### Manual environment setup

If you do not have the scripts folder, set the variables by hand in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("ADO_SERVER_URL",               "http://devdev:3040/tfs", "User")
[Environment]::SetEnvironmentVariable("ADO_COLLECTION",               "MyCollection",           "User")
[Environment]::SetEnvironmentVariable("ADO_API_VERSION",              "7.1",                    "User")
[Environment]::SetEnvironmentVariable("ADO_PAT",                      "<your-pat>",             "User")
[Environment]::SetEnvironmentVariable("NODE_TLS_REJECT_UNAUTHORIZED", "0",                      "User")
```

Open a new terminal after running these so the values take effect.

---

## Option B — Clone from a git bundle 🔜 (supported in the future)

The full repository bundle includes all source code, scripts, and docs.
Once available, the setup steps are the same as Option A — the only difference
is how you get the files onto your machine:

```powershell
git clone C:\path\to\azure-devops-mcp.bundle azure-devops-mcp
cd azure-devops-mcp
git checkout fix/bundle-undici   # or the branch that was bundled
```

Then continue from [Step 2](#step-2--set-up-environment-variables) above.

---

## Option C — Shared server with Docker 🔜 (supported in the future)

Runs one central server that every developer on the team connects to over the
network. No one needs Node.js on their own machine — they just point their AI
tool at a URL.

Requires Docker on the server machine and TLS (HTTPS) for the connection so
that Personal Access Tokens are not sent in plaintext.

Full setup details will be added here when this option is officially supported.
In the meantime, a draft of the Docker + nginx configuration can be found in
[`setup-shared-server.md`](setup-shared-server.md).
