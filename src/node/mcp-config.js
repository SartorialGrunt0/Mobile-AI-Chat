// MCP servers are configured in-app as URL + optional bearer token entries
// (Streamable HTTP transport per the MCP spec). The legacy LM Studio
// mcp.json-file path was retired: LM Studio receives these entries as
// ephemeral_mcp integrations, and the OpenAI-compatible transport executes
// their tools directly through the chat tool loop.

function normalizeMcpServers(value) {
  const entries = Array.isArray(value) ? value : [];
  const servers = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const url = String(entry.Url ?? entry.url ?? "").trim();
    if (!url) {
      continue;
    }

    const label = String(entry.Label ?? entry.label ?? "").trim() || deriveLabel(url);
    servers.push({
      Id: String(entry.Id ?? entry.id ?? "").trim() || deriveId(url),
      Label: label,
      Url: url,
      Token: String(entry.Token ?? entry.token ?? "").trim(),
      Enabled: entry.Enabled === undefined ? entry.enabled !== false : entry.Enabled !== false,
    });
  }

  return dedupeIds(servers);
}

function buildMcpServersResponse(servers) {
  return servers.map(server => ({
    id: server.Id,
    label: server.Label,
    url: server.Url,
    token: "",
    hasToken: Boolean(server.Token),
    enabled: server.Enabled,
  }));
}

function normalizeMcpServersPayload(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const entries = Array.isArray(value) ? value : [];
  return entries.map((entry, index) => ({
    Id: String(entry?.Id ?? entry?.id ?? "").trim() || `mcp-${index + 1}`,
    Label: String(entry?.Label ?? entry?.label ?? "").trim(),
    Url: String(entry?.Url ?? entry?.url ?? "").trim(),
    Token: String(entry?.Token ?? entry?.token ?? "").trim(),
    keepToken: entry?.keepToken === true,
    Enabled: entry?.Enabled === undefined ? entry?.enabled !== false : entry?.Enabled !== false,
  }));
}

function resolveMcpServerTokens(payloadServers, currentServers) {
  if (!payloadServers) {
    return null;
  }

  const currentById = new Map(currentServers.map(server => [server.Id, server]));

  return payloadServers.map((entry, index) => ({
    Id: entry.Id || `mcp-${index + 1}`,
    Label: entry.Label || deriveLabel(entry.Url),
    Url: entry.Url,
    Token: entry.keepToken ? (currentById.get(entry.Id)?.Token || "") : entry.Token,
    Enabled: entry.Enabled,
  }));
}

function validateMcpServers(servers) {
  for (const server of servers || []) {
    if (!server.Url) {
      return { mcpServers: "Every MCP server needs a URL." };
    }

    try {
      const parsed = new URL(server.Url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { mcpServers: `MCP server "${server.Label}" needs an absolute http:// or https:// URL.` };
      }
    } catch {
      return { mcpServers: `MCP server "${server.Label}" needs a valid URL.` };
    }
  }

  return null;
}

function findEnabledServers(servers, selectedIds) {
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
    return [];
  }

  const requested = new Set(selectedIds.map(id => String(id || "").trim().toLowerCase()));

  return (servers || []).filter(server => server.Enabled && requested.has(server.Id.toLowerCase()));
}

function deriveLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function deriveId(url) {
  return `mcp-${String(url).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
}

function dedupeIds(servers) {
  const seen = new Set();
  let counter = 0;

  for (const server of servers) {
    let candidate = server.Id;
    while (seen.has(candidate.toLowerCase())) {
      counter += 1;
      candidate = `${server.Id}-${counter}`;
    }
    seen.add(candidate.toLowerCase());
    server.Id = candidate;
  }

  return servers;
}

module.exports = {
  buildMcpServersResponse,
  findEnabledServers,
  normalizeMcpServers,
  normalizeMcpServersPayload,
  resolveMcpServerTokens,
  validateMcpServers,
};
