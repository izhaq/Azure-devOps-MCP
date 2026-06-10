# Local setup (stdio)

In **stdio** mode each developer runs the server locally and the MCP client
spawns it as a child process, talking over stdin/stdout. This is the simplest
setup and the right choice for individual use. For a shared team instance see
[`setup-hosted-http.md`](setup-hosted-http.md).

> **The server is client-agnostic.** Any MCP-capable client (Cursor, GitHub
> Copilot, Tabnine, Claude Desktop, …) works the same way: it runs a command,
> passes `--stdio`, and provides the connection settings as environment
> variables. Only the *location* and *shape* of the config file differ per client.

---

## 1. Prerequisites

- **Node.js >= 20** on your PATH (check with `node --version`).
- Your Azure DevOps Server URL and collection (e.g. `https://devops.corp.local/tfs`, `DefaultCollection`).
- A **Personal Access Token (PAT)** for that server with the scopes you need
  (read for browsing; read/write to create/update work items, PRs, etc.).

## 2. Install the server

**From the internal registry (most users):**

```bash
npm install -g @corp/azure-devops-mcp
# provides the `mcp-server-azuredevops` command
```

**From source (development):**

```bash
git clone https://github.com/izhaq/Azure-devOps-MCP.git
cd Azure-devOps-MCP
npm ci
npm run build
# entry point: dist/index.js
```

Pick the command form that matches your install:

- Global install → command `mcp-server-azuredevops`, args `["--stdio"]`
- From source → command `node`, args `["/absolute/path/to/dist/index.js", "--stdio"]`

## 3. Required settings

Every client config provides the same environment variables (full list in
[`configuration.md`](configuration.md)):

| Variable | Required | Example |
|---|---|---|
| `ADO_SERVER_URL` | yes | `https://devops.corp.local/tfs` |
| `ADO_COLLECTION` | no (default `DefaultCollection`) | `DefaultCollection` |
| `ADO_PAT` | **yes (stdio)** | `<your-pat>` |
| `ADO_API_VERSION` | no (default `7.1`) | `7.1` |

---

## 4. Client examples

All examples use the **global install** command form. To run from source,
replace `"command": "mcp-server-azuredevops"` with `"command": "node"` and put
the absolute path to `dist/index.js` as the first arg.

> **Keep your PAT out of git.** These files contain a secret. Prefer the VS Code
> `inputs` prompt pattern (below), keep client config files out of version
> control (e.g. add them to `.gitignore`), or supply `ADO_PAT` via your shell
> environment instead of hard-coding it.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "mcp-server-azuredevops",
      "args": ["--stdio"],
      "env": {
        "ADO_SERVER_URL": "https://devops.corp.local/tfs",
        "ADO_COLLECTION": "DefaultCollection",
        "ADO_PAT": "<your-pat>"
      }
    }
  }
}
```

### GitHub Copilot (VS Code)

`.vscode/mcp.json` in your workspace. VS Code prompts for `inputs` so the PAT
isn't stored in plaintext:

```json
{
  "inputs": [
    { "id": "ado-pat", "type": "promptString", "description": "Azure DevOps PAT", "password": true }
  ],
  "servers": {
    "azure-devops": {
      "type": "stdio",
      "command": "mcp-server-azuredevops",
      "args": ["--stdio"],
      "env": {
        "ADO_SERVER_URL": "https://devops.corp.local/tfs",
        "ADO_COLLECTION": "DefaultCollection",
        "ADO_PAT": "${input:ado-pat}"
      }
    }
  }
}
```

### Tabnine

In Tabnine's MCP configuration file (`~/.tabnine/mcp_servers.json` globally, or
`.tabnine/mcp_servers.json` in a project), add a server with the same shape:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "mcp-server-azuredevops",
      "args": ["--stdio"],
      "env": {
        "ADO_SERVER_URL": "https://devops.corp.local/tfs",
        "ADO_COLLECTION": "DefaultCollection",
        "ADO_PAT": "<your-pat>"
      }
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "mcp-server-azuredevops",
      "args": ["--stdio"],
      "env": {
        "ADO_SERVER_URL": "https://devops.corp.local/tfs",
        "ADO_COLLECTION": "DefaultCollection",
        "ADO_PAT": "<your-pat>"
      }
    }
  }
}
```

### Any other MCP client

The contract is always the same:

- **command:** `mcp-server-azuredevops` (or `node`)
- **args:** `["--stdio"]` (plus `dist/index.js` first when using `node`)
- **env:** at least `ADO_SERVER_URL` and `ADO_PAT`

---

## 5. Loading only some tools

Large tool sets can crowd a client's tool list. Restrict to the domains you use
with `-d` (overrides `ADO_DOMAINS`):

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "mcp-server-azuredevops",
      "args": ["--stdio", "-d", "core,work-items,repositories"],
      "env": {
        "ADO_SERVER_URL": "https://devops.corp.local/tfs",
        "ADO_PAT": "<your-pat>"
      }
    }
  }
}
```

Valid domains: `core`, `work`, `work-items`, `repositories`, `pipelines`,
`wiki`, `test-plans`.

## 6. Verify it runs

Before wiring a client, confirm the binary works from a terminal:

```bash
mcp-server-azuredevops --version
mcp-server-azuredevops --help
```

A quick smoke test (validates config and starts the server) — set the env first:

```bash
export ADO_SERVER_URL="https://devops.corp.local/tfs"
export ADO_PAT="<your-pat>"
mcp-server-azuredevops --stdio
```

The process waits for MCP JSON-RPC on stdin; that it starts without a config
error means your settings are valid. Your client drives it from there.

## 7. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Invalid configuration: ADO_SERVER_URL …` at startup | Missing or malformed URL. Set a full `https://…` value. |
| Tool calls fail with “No Azure DevOps PAT available” | `ADO_PAT` not set in the client's `env`. |
| `command not found: mcp-server-azuredevops` | Global install not on PATH; use the `node dist/index.js` form with an absolute path. |
| `Unknown domain(s): …` | Typo in `-d`/`ADO_DOMAINS`. Use only the valid domain names above. |
| 401/403 from Azure DevOps | PAT lacks scope or is expired; or wrong collection/`ADO_API_VERSION` for your server build. |

See [`configuration.md`](configuration.md) for every setting and default.
