// Minimal MCP client for the Streamable HTTP transport.
// Each logical operation runs initialize -> initialized -> request against the
// server endpoint, which works against both stateful servers (session id is
// echoed when one is issued) and stateless servers. Authentication is the
// bearer token from the configured MCP server entry, per the MCP auth guidance.

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_REQUEST_TIMEOUT_MS = 30000;
const MCP_MAX_TOOL_PAGES = 10;

class McpClientError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function listTools(server, signal = null) {
  const session = await openSession(server, signal);
  const tools = [];
  let cursor = null;

  for (let page = 0; page < MCP_MAX_TOOL_PAGES; page += 1) {
    const result = await rpcRequest(server, session, "tools/list", cursor ? { cursor } : {}, signal);
    for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
      if (tool && typeof tool.name === "string" && tool.name) {
        tools.push({
          name: tool.name,
          description: String(tool.description || ""),
          inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
        });
      }
    }

    cursor = result?.nextCursor || null;
    if (!cursor) {
      break;
    }
  }

  return tools;
}

async function callTool(server, toolName, args, signal = null) {
  const session = await openSession(server, signal);
  const result = await rpcRequest(server, session, "tools/call", {
    name: toolName,
    arguments: args && typeof args === "object" ? args : {},
  }, signal);

  const text = extractResultText(result);
  if (result?.isError === true) {
    throw new McpClientError(text || `MCP tool ${toolName} reported an error.`);
  }

  return text;
}

async function probeServer(server, signal = null) {
  const tools = await listTools(server, signal);
  return { ok: true, toolCount: tools.length };
}

async function openSession(server, signal) {
  const session = { sessionId: "" };

  const initResponse = await postJsonRpc(server, session, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mobile-ai-chat", version: "1.0.0" },
    },
  }, signal);

  const payload = await readJsonRpcResponse(initResponse, 1, server);
  session.sessionId = readHeader(initResponse, "mcp-session-id") || "";

  await postJsonRpc(server, session, { jsonrpc: "2.0", method: "notifications/initialized" }, signal, true);

  if (!payload) {
    throw new McpClientError(`MCP server "${server.Label}" returned an invalid initialize response.`);
  }

  return session;
}

async function rpcRequest(server, session, method, params, signal) {
  const response = await postJsonRpc(server, session, {
    jsonrpc: "2.0",
    id: 2,
    method,
    params,
  }, signal);

  const payload = await readJsonRpcResponse(response, 2, server);
  if (payload?.error) {
    throw new McpClientError(payload.error.message || `MCP server "${server.Label}" rejected ${method}.`);
  }

  return payload?.result ?? null;
}

async function postJsonRpc(server, session, message, signal, allowEmpty = false) {
  if (!server.Url) {
    throw new McpClientError(`MCP server "${server.Label}" has no URL configured.`);
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };

  if (session.sessionId) {
    headers["Mcp-Session-Id"] = session.sessionId;
  }

  if (server.Token) {
    headers.Authorization = `Bearer ${server.Token}`;
  }

  const response = await fetch(server.Url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: composeSignal(signal),
  }).catch(error => {
    if (error?.name === "AbortError") {
      throw error;
    }
    throw new McpClientError(`Unable to reach MCP server "${server.Label}" at ${server.Url}: ${error.message}`);
  });

  if (!response.ok) {
    const detail = allowEmpty ? "" : await readErrorDetail(response);
    throw new McpClientError(`MCP server "${server.Label}" returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ""}`, response.status);
  }

  return response;
}

async function readJsonRpcResponse(response, expectedId, server) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("text/event-stream")) {
    return await readJsonRpcFromSse(response.body, expectedId);
  }

  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpClientError(`MCP server "${server.Label}" returned a non-JSON response.`);
  }

  if (Array.isArray(parsed)) {
    return parsed.find(entry => entry?.id === expectedId) || parsed.find(entry => entry?.method || entry?.result || entry?.error) || null;
  }

  return parsed;
}

async function readJsonRpcFromSse(sourceStream, expectedId) {
  const reader = sourceStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let found = null;

  while (!found) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r/g, "");

    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex >= 0) {
      const frame = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      for (const line of frame.split("\n")) {
        if (!line.toLowerCase().startsWith("data:")) {
          continue;
        }

        const payload = line.slice(5).trim();
        if (!payload) {
          continue;
        }

        try {
          const parsed = JSON.parse(payload);
          if (parsed?.id === expectedId) {
            found = parsed;
          }
        } catch {
        }
      }

      boundaryIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      break;
    }
  }

  return found;
}

async function readErrorDetail(response) {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }

    try {
      const parsed = JSON.parse(text);
      return String(parsed?.error?.message || parsed?.message || "").slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return "";
  }
}

function extractResultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const parts = [];

  for (const block of blocks) {
    if (block?.type === "text") {
      parts.push(String(block.text || ""));
    } else if (block?.type === "image") {
      parts.push(`[image ${block.mimeType || block.mime_type || "content"} omitted]`);
    } else if (block?.type === "resource") {
      parts.push(String(block?.resource?.text || "[resource omitted]"));
    }
  }

  if (typeof result?.structuredContent === "object" && result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent));
  }

  return parts.join("\n").trim();
}

function readHeader(response, name) {
  try {
    return response.headers.get(name) || "";
  } catch {
    return "";
  }
}

function composeSignal(signal) {
  const timeout = AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

module.exports = {
  McpClientError,
  callTool,
  listTools,
  probeServer,
};
