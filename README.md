# Mobile AI Chat

Mobile AI Chat is a lightweight, mobile-first Node.js web client for chatting with local and remote LLMs. It runs in Docker and is usable from a phone on the same network.

This repository now tracks the Node.js runtime, the static client, and Docker and local development workflows only.

## Providers

- **LM Studio** — local LM Studio server, including model load/unload controls and MCP tool execution
- **OpenAI Compatible** — any OpenAI-compatible `/v1` endpoint: OpenAI itself, a llama.cpp or Ollama server on your network, or any hosted OpenAI-style API
- **Hermes Agent** — a Hermes Agent deployment exposed through its OpenAI-compatible endpoint

Each provider keeps its own base URL and API key, configured per provider on the in-app Settings screen. LM Studio remains the default provider.

## Features

- Mobile-first chat UI with a minimal layout
- Saved chat history in SQLite
- Model list, load, and unload controls (LM Studio; remote providers use model ids)
- Model temperature control alongside context and reasoning settings
- Streamed responses with live text rendering
- Expandable reasoning and tool call sections
- End-of-response stats including tokens per second and input context usage
- MCP server management (URL + bearer token) with per-chat tool selection
- Cookie-protected PIN login for LAN use

## Project Layout

- `src/node`: Node.js runtime, SQLite integration, and provider clients (LM Studio and OpenAI-compatible)
- `src/MobileLmStudio/wwwroot`: static mobile-first client assets served by the Node.js runtime
- `src/MobileLmStudio/appsettings.json`: default application settings used by the Node.js runtime
- `Dockerfile`: container image definition
- `docker-compose.yml`: ready-to-run Compose configuration
- `docker-compose.example.yml`: commented Compose example template
- `scripts/dev-server.ps1`: local development entry point
- `reference/lm_studio_rest_api`: LM Studio API reference used to build the integration

## Docker

Docker is the recommended way to run Mobile AI Chat.

### Quick start

The repo ships a runnable default Compose file:

```sh
docker compose up -d
```

That builds the image, starts the container, and serves the UI on `http://localhost:5080`.
Chat data is stored in the `mobile-lm-studio-data` named volume so it survives container restarts and upgrades.

By default the container expects LM Studio on the host machine at `http://host.docker.internal:1234`.
Docker Desktop resolves that automatically on Windows and macOS.
On Linux, keep the included `extra_hosts` entry or set `LMSTUDIO_URL` to your host IP directly.

### Example docker-compose

The repo also includes a tracked example at `docker-compose.example.yml`:

```yaml
services:
  mobile-lm-studio:
    build:
      context: .
    ports:
      - "5080:5080"
    environment:
      LMSTUDIO_URL: http://host.docker.internal:1234
      # LMSTUDIO_API_TOKEN: your-token-here
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - mobile-lm-studio-data:/data
    restart: unless-stopped

volumes:
  mobile-lm-studio-data:
```

You can run that file directly:

```sh
docker compose -f docker-compose.example.yml up -d
```

### Configuration via environment variables

All settings can be passed as environment variables in `docker-compose.yml`, `docker-compose.example.yml`, or with `-e` on the command line:

| Variable | Description | Default |
|---|---|---|
| `LMSTUDIO_URL` | LM Studio server URL | `http://127.0.0.1:1234` |
| `LMSTUDIO_API_TOKEN` | Bearer token for LM Studio requests | _(empty)_ |
| `WEB_PORT` | Port the server listens on | `5080` |
| `DATA_DIR` | Directory for the SQLite database, runtime settings, and logs | `/data` |

Example overriding the LM Studio host at launch time:

```sh
LMSTUDIO_URL=http://192.168.1.10:1234 docker compose up -d
```

### MCP servers

MCP servers are configured in the in-app Settings screen — no files to mount. Each entry is a
Streamable HTTP MCP endpoint: a label, a URL, and an optional bearer token. Every provider can
use them: LM Studio receives the enabled servers selected in a chat as ephemeral MCP
integrations, and the OpenAI-compatible and Hermes Agent providers call their tools directly
through the chat tool loop.

### Upgrading

```sh
docker compose build --pull
docker compose up -d
```

### Removing

```sh
docker compose down
```

To also delete the chat database and all stored data:

```sh
docker compose down -v
```

## Run The UI Locally

If you want to run directly from source without Docker:

```powershell
./scripts/dev-server.ps1
```

That starts the Node.js server on `http://127.0.0.1:5081`, stores chat data in `artifacts/dev/mobile-lm-studio.db`, and isolates runtime settings under `artifacts/dev/programdata` so local iteration stays separate from the shared Docker data volume.

You can override the main development settings:

```powershell
./scripts/dev-server.ps1 -Port 5090 -LmStudioUrl http://127.0.0.1:1234
```

You can enable, disable, or rotate the UI PIN later from the in-app Settings screen.

## Configuration

Settings are loaded in this order, from lowest to highest priority:

1. Built-in defaults in `src/node/config.js`
2. `appsettings.json`
3. Environment variables
4. `appsettings.runtime.json`
5. CLI arguments

Runtime changes made in the UI are written to `appsettings.runtime.json`, so saved settings override environment variables on later restarts.

`appsettings.json` keys:

- `Providers:ActiveProvider`: the provider the chat uses (`lmstudio`, `openai`, or `hermes-agent`)
- `Providers:Profiles:<provider-id>`: per-provider `BaseUrl` and `ApiToken`
- `LmStudio:BaseUrl`: LM Studio server URL (legacy alias for `Providers:Profiles:lmstudio:BaseUrl`)
- `LmStudio:ApiToken`: bearer token used for LM Studio requests
- `McpServers`: the configured MCP server list (`Id`, `Label`, `Url`, `Token`, `Enabled`)
- `Security:PinHash` and `Security:PinSalt`: PBKDF2-protected PIN values
- `Storage:ConnectionString`: SQLite connection string
- `Web:Urls`: URL binding for the server

In Docker the data directory defaults to `/data`.
When you use `scripts/dev-server.ps1`, the runtime settings and logs are redirected under `artifacts/dev/programdata`.

Logs are written to `{data-dir}/logs/YYYYMMDD.log`.