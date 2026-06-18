# Shared MCP Server — Setup Guide for the Whole Team

This guide explains how to host **one central MCP server** that every developer
in your team connects to — instead of each person running their own copy.

It is written in two parts:
- **Part 1** — for the person who sets up the server (IT / DevOps person, one time only)
- **Part 2** — for each developer who wants to connect

---

## The Big Picture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Your Internal Network                        │
│                                                                 │
│  ┌─────────────┐        ┌──────────────────┐                   │
│  │  Developer  │──PAT──▶│  MCP Server      │──▶  Azure DevOps  │
│  │  (Tabnine / │        │  (shared, always │     Server        │
│  │  Claude)    │        │   running)       │                   │
│  └─────────────┘        └──────────────────┘                   │
│                                                                 │
│  ┌─────────────┐                ▲                              │
│  │  Developer  │──PAT──────────┘                              │
│  └─────────────┘                                               │
│                                                                 │
│  ┌─────────────┐                                               │
│  │  Developer  │──PAT──▶ (same server)                        │
│  └─────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

**How the PAT works in shared mode:**
The server itself holds **no password**. Instead, every developer sends their own
Personal Access Token with every request (in an HTTP header called `X-ADO-PAT`).
The server uses that token to call Azure DevOps on behalf of that specific person.
This means each developer only sees what they are allowed to see — their own work
items, their own PRs, their own restrictions — exactly as if they had logged in
directly to Azure DevOps.

---

## Before you start — what you need

| Thing | Who needs it |
|---|---|
| A **Linux or Windows server** on the internal network | IT/DevOps person |
| **Docker** installed on that server | IT/DevOps person |
| A **domain name** or IP for the server (e.g. `ado-mcp.yourcompany.local`) | IT/DevOps person |
| An **SSL certificate** for that domain (your company's internal CA is fine) | IT/DevOps person |
| A **Personal Access Token** from Azure DevOps | Every developer |
| **Tabnine CLI** or **Claude Code** installed | Every developer |

> **What is Docker?**
> Docker is a tool that packages an application and everything it needs into one
> tidy box called a "container". You start the box with one command, and it just
> works — no need to install Node.js or any dependencies on the server itself.

---

## Part 1 — Setting up the server (IT / DevOps person)

### Step 1 — Install Docker

If Docker is not already on the server, follow the official guide for your OS:
- Linux (Ubuntu): https://docs.docker.com/engine/install/ubuntu/
- Windows Server: https://docs.docker.com/desktop/install/windows-install/

Check it is working:
```bash
docker --version
# Should print something like: Docker version 26.x.x
```

---

### Step 2 — Get the MCP server image

On the server, clone the repository and build the Docker image:

```bash
git clone https://github.com/izhaq/Azure-devOps-MCP.git
cd Azure-devOps-MCP
docker build -t azure-devops-mcp:latest .
```

> **What does this do?**
> It reads the `Dockerfile` in the project and builds a self-contained image —
> like compiling and packaging the app — and gives it the name `azure-devops-mcp`.
> This takes a minute the first time and is much faster on rebuilds.

---

### Step 3 — Start the server

Create a file called `docker-compose.yml` on the server (anywhere is fine,
e.g. `/opt/ado-mcp/docker-compose.yml`):

```yaml
services:
  azure-devops-mcp:
    image: azure-devops-mcp:latest
    restart: unless-stopped
    # Only listen on localhost — the nginx proxy (Step 4) is the public face.
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      # Your Azure DevOps Server address (no trailing slash)
      ADO_SERVER_URL: "https://azuredevops.yourcompany.local"
      # Your collection name inside Azure DevOps
      ADO_COLLECTION: "YourCollection"
      # The API version your Azure DevOps Server supports (7.1 is safe for most)
      ADO_API_VERSION: "7.1"
      # The public URL that developers use to reach this MCP server.
      # Used to allow requests from that address; must match what nginx serves.
      ADO_ALLOWED_ORIGINS: "https://ado-mcp.yourcompany.local"
      ADO_LOG_LEVEL: "info"
      # Note: NO ADO_PAT here. Each developer sends their own PAT per request.
```

Start it:
```bash
docker compose up -d
```

Check it is running:
```bash
docker compose ps
# Should show:  azure-devops-mcp   running (healthy)
```

> **`restart: unless-stopped`** means Docker will automatically restart the
> server if the machine reboots or the process crashes.

---

### Step 4 — Set up HTTPS with nginx

> **Why HTTPS?**
> Every developer's Personal Access Token travels inside each request.
> Without HTTPS, anyone on the network could intercept it. HTTPS encrypts the
> connection so the token is never visible in transit.

> **What is nginx?**
> nginx (pronounced "engine-x") is a lightweight web server. Here we use it as a
> "reverse proxy" — it sits in front of the MCP server, handles the encrypted
> HTTPS connection, and forwards requests to it.

Install nginx on the server:
```bash
# Ubuntu / Debian
sudo apt install nginx

# RHEL / Rocky Linux
sudo dnf install nginx
```

Create a config file at `/etc/nginx/sites-available/ado-mcp`:

```nginx
server {
    listen 443 ssl;
    server_name ado-mcp.yourcompany.local;

    # Point these at your company's internal SSL certificate files.
    # These are usually provided by your IT department.
    ssl_certificate     /etc/ssl/company/ado-mcp.crt;
    ssl_certificate_key /etc/ssl/company/ado-mcp.key;

    location /mcp {
        # Forward requests to the MCP server running on port 3000
        proxy_pass http://127.0.0.1:3000/mcp;
        proxy_http_version 1.1;

        # These lines pass important information to the MCP server
        proxy_set_header Host              $host;
        proxy_set_header X-ADO-PAT         $http_x_ado_pat;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Give Azure DevOps enough time to respond
        proxy_read_timeout 60s;
    }
}

# Redirect plain HTTP to HTTPS
server {
    listen 80;
    server_name ado-mcp.yourcompany.local;
    return 301 https://$host$request_uri;
}
```

Enable the site and restart nginx:
```bash
sudo ln -s /etc/nginx/sites-available/ado-mcp /etc/nginx/sites-enabled/
sudo nginx -t      # Check the config has no typos
sudo systemctl reload nginx
```

---

### Step 5 — Verify the server is working

From any machine that can reach the server, run this command
(it should get a `401` — that means the server is up, it just wants a PAT):

```bash
curl -i -X POST https://ado-mcp.yourcompany.local/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

**What you should see:**
```
HTTP/2 401
{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized: missing x-ado-pat header."},"id":null}
```

A `401` here is **good** — the server is running and asking for a PAT.
If you see `connection refused` or a timeout, go back and check Steps 3 and 4.

Now test with a real PAT (replace `<YOUR-PAT>` with an actual token):

```bash
curl -i -X POST https://ado-mcp.yourcompany.local/mcp \
  -H "Content-Type: application/json" \
  -H "X-ADO-PAT: <YOUR-PAT>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

**What you should see:**
```
HTTP/2 200
{"jsonrpc":"2.0","result":{"protocolVersion":"2025-06-18","capabilities":{...},"serverInfo":{"name":"azure-devops-mcp",...}},"id":1}
```

If you see a `200` with server info — the server is fully working. Tell your developers the URL:
```
https://ado-mcp.yourcompany.local/mcp
```

---

## Part 2 — Connecting to the server (every developer)

Each developer does this on their own machine. You only need to do it once.

---

### Step 1 — Create a Personal Access Token (PAT)

1. Open your browser and log in to Azure DevOps:
   ```
   https://azuredevops.yourcompany.local/YourCollection/_usersSettings/tokens
   ```
2. Click **New Token**.
3. Give it a name like `tabnine-mcp` or `claude-mcp`.
4. Set an expiration date (90 days is typical).
5. Under **Scopes**, choose **Custom defined** and tick:
   - **Code** → Read
   - **Work Items** → Read & Write (or just Read if you won't create/edit work items)
   - **Build** → Read (optional, for pipelines)
   - **Wiki** → Read & Write (optional)
6. Click **Create**.
7. **Copy the token now** — you will not be able to see it again after you close this dialog.

> **Keep your PAT secret.** It is like a password. Do not paste it into chat,
> email, or commit it to git. If you accidentally expose it, go back to Azure
> DevOps and revoke it immediately, then create a new one.

---

### Step 2 — Configure Tabnine CLI

Open (or create) Tabnine's MCP configuration file.

**File location:**
- **Windows:** `C:\Users\<YourName>\.tabnine\mcp_servers.json`
- **Linux/Mac:** `~/.tabnine/mcp_servers.json`

Add the following (replace `<YOUR-PAT>` with the token you just created):

```json
{
  "mcpServers": {
    "azure-devops": {
      "url": "https://ado-mcp.yourcompany.local/mcp",
      "headers": {
        "X-ADO-PAT": "<YOUR-PAT>"
      }
    }
  }
}
```

Save the file, then **restart Tabnine CLI**.

> **What is `headers`?**
> When Tabnine sends a request to the MCP server, it includes extra information
> called "headers". Here we are telling it to always include your PAT as a header
> called `X-ADO-PAT`. The server reads that header and uses your PAT to talk to
> Azure DevOps on your behalf.

---

### Step 3 — Configure Claude Code

**Option A — using the terminal (quickest):**

```bash
claude mcp add --transport http azure-devops https://ado-mcp.yourcompany.local/mcp
```

Then edit the config to add your PAT header. Open `~/.claude.json` (or
`C:\Users\<YourName>\.claude.json` on Windows) and find the `azure-devops`
entry under `mcpServers`. Add a `headers` field:

```json
{
  "mcpServers": {
    "azure-devops": {
      "type": "http",
      "url": "https://ado-mcp.yourcompany.local/mcp",
      "headers": {
        "X-ADO-PAT": "<YOUR-PAT>"
      }
    }
  }
}
```

**Option B — edit the file directly:**

Open `~/.claude.json` (Windows: `C:\Users\<YourName>\.claude.json`) and add
the block above under `mcpServers`. If the file does not exist yet, create it
with the content above as the entire file.

After saving, **restart Claude Code**.

---

### Step 4 — Test your connection

**In Tabnine:** ask it something like:
> *"List the projects in our Azure DevOps"*

**In Claude Code:** try:
> *"What Azure DevOps projects do we have?"*

If you get back a list of real project names — you are done.

---

## Keeping your PAT fresh

PATs expire (typically after 90 days). When yours expires, tool calls will start
failing with an `Unauthorized` error. The fix is simple:

1. Go back to Azure DevOps and create a new PAT (same steps as Step 1 above).
2. Open your Tabnine and/or Claude Code config files.
3. Replace the old `<YOUR-PAT>` value with the new one.
4. Save and restart your AI tool.

---

## Troubleshooting

### "Unauthorized: missing x-ado-pat header"

Your client is not sending the PAT header. Check that:
- The `headers` section is in your config file (not just `env`).
- There are no typos — the header name must be exactly `X-ADO-PAT`.
- You restarted your AI tool after editing the config.

### "Unauthorized" / `TF400813` from Azure DevOps itself

Your PAT is wrong, expired, or missing permissions:
- Double-check you copied the full token when you created it.
- Go to Azure DevOps → User Settings → Personal Access Tokens and check it has not expired.
- Make sure the PAT has **Code → Read** and **Work Items → Read** at minimum.

### Connection refused / timeout

The MCP server is not reachable:
- Ask your IT person to confirm the server is running (`docker compose ps`).
- Confirm you can ping `ado-mcp.yourcompany.local` from your machine.
- Try the `curl` test from Step 5 of Part 1 to confirm the server responds.

### Tabnine does not show Azure DevOps tools

- Confirm the config file is valid JSON. You can check by pasting the file
  content into https://jsonlint.com (on a machine with internet access).
- Confirm the file is in the right location (see Step 2 above).
- Restart Tabnine CLI after making any config change.

---

## For IT: updating to a new version of the server

When a new version is released, pull the latest code and rebuild the image:

```bash
cd Azure-devOps-MCP
git pull
docker build -t azure-devops-mcp:latest .
docker compose up -d
```

Docker will replace the running container with the new image. Developers do not
need to change anything — they keep using the same URL.

---

## Reference — full list of server settings

The server is configured entirely through environment variables in `docker-compose.yml`.
For the complete list see [`configuration.md`](configuration.md).

The most commonly tuned ones for a shared deployment:

| Variable | What it does | Default |
|---|---|---|
| `ADO_SERVER_URL` | Your Azure DevOps server address | _(required)_ |
| `ADO_COLLECTION` | Collection name | `DefaultCollection` |
| `ADO_API_VERSION` | ADO REST API version | `7.1` |
| `ADO_ALLOWED_ORIGINS` | Public URL of this MCP server (for security) | _(none)_ |
| `ADO_TIMEOUT_MS` | How long to wait for Azure DevOps to respond (ms) | `30000` |
| `ADO_MAX_RESULTS` | Maximum items returned per list call | `200` |
| `ADO_LOG_LEVEL` | How much the server logs (`debug`/`info`/`warn`/`error`) | `info` |
