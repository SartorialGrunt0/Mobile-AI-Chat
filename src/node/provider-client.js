const { TextDecoder } = require("node:util");
const { fetchWithHeadersTimeout, readWithIdleTimeout } = require("./fetch-timeout");

// Delta windows shorter than this are frame-coalescing noise, not a measurable
// decode rate; tokens_per_second is left null for them instead of reporting noise.
const MIN_DECODE_WINDOW_MS = 10;
const MAX_TOOL_ROUNDS = 8;
const OPENAI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const { LmStudioClient } = require("./lm-studio-client");
const { listTools: listMcpTools, callTool: runMcpTool } = require("./mcp-client");
const { relayLmStudioStream } = require("./lm-studio-stream");
const { getActiveProviderId, getProviderConnectionSettings, getProviderDefinition } = require("./provider-config");

class ProviderClient {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.lmStudioClient = new LmStudioClient(() => {
      const connection = getProviderConnectionSettings(this.getConfig(), "lmstudio");
      return {
        baseUrl: connection.baseUrl,
        apiToken: connection.apiToken,
      };
    });
  }

  getActiveConnection(providerId = null) {
    const config = this.getConfig();
    const resolvedProviderId = providerId || getActiveProviderId(config);
    return getProviderConnectionSettings(config, resolvedProviderId);
  }

  getActiveProviderInfo(providerId = null) {
    const connection = this.getActiveConnection(providerId);
    return {
      ...connection,
      displayName: connection.definition.displayName,
      supportsModelLoad: connection.definition.supportsModelLoad,
      supportsMcp: connection.definition.supportsMcp,
    };
  }

  async getModels(providerId = null) {
    const connection = this.getActiveConnection(providerId);
    switch (connection.definition.kind) {
      case "lmstudio":
        return this.lmStudioClient.getModels();
      default:
        return this.getOpenAiCompatibleModels(connection);
    }
  }

  async loadModel(requestModel, providerId = null) {
    const connection = this.getActiveConnection(providerId);
    if (connection.definition.kind !== "lmstudio") {
      throw unsupportedProviderAction(connection.definition.displayName, "load and unload");
    }

    return this.lmStudioClient.loadModel(requestModel);
  }

  async unloadModel(requestModel, providerId = null) {
    const connection = this.getActiveConnection(providerId);
    if (connection.definition.kind !== "lmstudio") {
      throw unsupportedProviderAction(connection.definition.displayName, "load and unload");
    }

    return this.lmStudioClient.unloadModel(requestModel);
  }

  async streamChat(request, signal, onEvent, providerId = null) {
    const connection = this.getActiveConnection(providerId);
    switch (connection.definition.kind) {
      case "lmstudio":
        return this.streamLmStudioChat(connection, request, signal, onEvent);
      default:
        return this.streamOpenAiCompatibleChat(connection, request, signal, onEvent);
    }
  }

  async generateTitle(model, input, providerId = null) {
    const connection = this.getActiveConnection(providerId);
    if (!model || !String(model).trim()) {
      return null;
    }

    if (connection.definition.kind === "lmstudio") {
      return this.lmStudioClient.generateTitle(model, input);
    }

    const content = await this.generateText(connection, {
      model,
      systemPrompt: "Generate a short chat title (5 words max). Respond with only the title, no quotes or extra text.",
      userPrompt: String(input || "").slice(0, 500),
      maxTokens: 64,
      temperature: 0.2,
    }, true);

    if (!content) {
      return null;
    }

    const title = String(content).trim().replace(/^['"]|['"]$/g, "");
    return title.length > 60 ? `${title.slice(0, 57)}...` : title;
  }

  async generateAdaptiveMemory(model, options, providerId = null) {
    const connection = this.getActiveConnection(providerId);
    if (!model || !String(model).trim()) {
      return String(options?.existingSummary || "").trim();
    }

    if (connection.definition.kind === "lmstudio") {
      return this.lmStudioClient.generateAdaptiveMemory(model, options);
    }

    const maxWords = Math.max(50, Number.parseInt(options?.maxWords, 10) || 500);
    const content = await this.generateText(connection, {
      model,
      systemPrompt: [
        "Maintain a compact, durable memory profile for a chat user.",
        "Update the profile using the existing memory and the newly observed user messages.",
        "Keep only stable preferences, recurring interests, communication style, output preferences, and durable project context.",
        "Do not store secrets, one-off transient tasks, or speculative personal details.",
        `Return bullet points only and stay within ${maxWords} words.`,
      ].join(" "),
      userPrompt: buildAdaptiveMemoryPrompt(options),
      maxTokens: Math.min(Math.max(maxWords * 5, 256), 2000),
      temperature: 0,
    });

    return truncateWords(String(content || options?.existingSummary || "").trim(), maxWords);
  }

  async streamLmStudioChat(_connection, request, signal, onEvent) {
    const response = await this.lmStudioClient.startChatStream({
      model: request.model,
      input: buildLmStudioInput(request.input, request.attachments),
      system_prompt: request.systemPrompt,
      reasoning: request.reasoning,
      stream: true,
      store: true,
      context_length: request.contextLength,
      temperature: request.temperature,
      top_k: request.topK,
      top_p: request.topP,
      min_p: request.minP,
      repeat_penalty: request.repeatPenalty,
      previous_response_id: request.previousResponseId || null,
      integrations: Array.isArray(request.integrations) && request.integrations.length > 0 ? request.integrations : null,
    }, signal);

    if (!response.ok) {
      throw new Error(await this.lmStudioClient.readError(response));
    }

    return relayLmStudioStream(response.body, onEvent);
  }

  async streamOpenAiCompatibleChat(connection, request, signal, onEvent) {
    const mcpServers = Array.isArray(request.mcpServers) ? request.mcpServers : [];
    const toolRegistry = mcpServers.length > 0 ? await buildToolRegistry(mcpServers, signal) : null;

    const streamStartedAtMs = Date.now();
    let firstDeltaAtMs = null;
    // Decode time is summed PER ROUND so MCP tool execution wall-clock and
    // per-round request latency are excluded from tokens_per_second.
    let decodeActiveMs = 0;

    const messages = buildOpenAiMessages(request.messages, request.systemPrompt);
    const usageTotals = { input_tokens: null, output_tokens: null, cached_input_tokens: null };
    const reasoningParts = [];
    const contentParts = [];
    const toolCallRecords = [];
    let responseId = null;

    for (let round = 0; ; round += 1) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      const roundTiming = { first: null, last: null };
      const markDeltaTiming = () => {
        const deltaAtMs = Date.now();
        if (roundTiming.first === null) {
          roundTiming.first = deltaAtMs;
        }
        roundTiming.last = deltaAtMs;
      };

      const roundResult = await streamSingleRound(this, connection, request, messages, toolRegistry, round === 0, signal, onEvent, markDeltaTiming);
      if (roundTiming.first !== null) {
        firstDeltaAtMs = firstDeltaAtMs ?? roundTiming.first;
        decodeActiveMs += Math.max(roundTiming.last - roundTiming.first, 0);
      }
      responseId = roundResult.responseId || responseId;
      accumulateUsage(usageTotals, roundResult.usage);
      reasoningParts.push(roundResult.reasoning);
      contentParts.push(roundResult.content);

      if (roundResult.toolCalls.length === 0) {
        break;
      }

      if (round >= MAX_TOOL_ROUNDS) {
        throw new Error(`Tool calling stopped after ${MAX_TOOL_ROUNDS} rounds without a final answer.`);
      }

      messages.push({
        role: "assistant",
        content: roundResult.content || null,
        tool_calls: roundResult.toolCalls.map(entry => ({
          id: entry.id,
          type: "function",
          function: { name: entry.name, arguments: entry.arguments || "{}" },
        })),
      });

      for (const entry of roundResult.toolCalls) {
        const resolved = toolRegistry ? toolRegistry.resolve(entry.name) : null;
        await onEvent("tool_call.start", JSON.stringify({ tool: resolved ? resolved.displayName : entry.name }));

        const parsedArguments = entry.arguments ? safeParseJson(entry.arguments) : {};
        if (!parsedArguments || typeof parsedArguments !== "object") {
          // Truncated/garbled streamed arguments: do NOT execute the tool with
          // an empty object — report it so the model can retry (mirrors the
          // LM Studio path's invalid_tool_call handling).
          const invalidArgumentsFailure = "The model produced invalid tool arguments; the tool was not executed. Retry with complete, valid JSON arguments.";
          await onEvent("tool_call.failure", JSON.stringify({ output: invalidArgumentsFailure }));
          toolCallRecords.push({ tool: resolved?.displayName || entry.name, arguments: {}, output: invalidArgumentsFailure });
          messages.push({ role: "tool", tool_call_id: entry.id, content: invalidArgumentsFailure });
          continue;
        }
        await onEvent("tool_call.arguments", JSON.stringify({ arguments: parsedArguments }));

        let toolOutput;
        try {
          toolOutput = resolved
            ? await callMcpTool(resolved.server, resolved.toolName, parsedArguments, signal)
            : `Unknown tool ${entry.name}.`;
          await onEvent("tool_call.success", JSON.stringify({ output: toolOutput }));
        } catch (error) {
          if (error?.name === "AbortError" || signal?.aborted) {
            // A user-initiated stop must propagate, not surface as a tool failure.
            throw error;
          }
          toolOutput = `Tool call failed: ${error.message}`;
          await onEvent("tool_call.failure", JSON.stringify({ output: toolOutput }));
        }

        toolCallRecords.push({ tool: resolved?.displayName || entry.name, arguments: parsedArguments, output: toolOutput });
        messages.push({ role: "tool", tool_call_id: entry.id, content: String(toolOutput ?? "") });
      }
    }

    return buildFinalResponse({
      model: request.model,
      contextLength: request.contextLength,
      responseId,
      reasoning: reasoningParts.filter(Boolean).join("\n"),
      content: contentParts.filter(Boolean).join("\n"),
      usage: usageTotals,
      toolCalls: toolCallRecords,
      timings: { streamStartedAtMs, firstDeltaAtMs, decodeActiveMs },
    });
  }



  async getOpenAiCompatibleModels(connection) {
    const response = await this.sendJson(connection, "GET", "models", undefined, {
      allowFailure: true,
    });

    if (!response.ok) {
      if (response.status === 404 || response.status === 405) {
        return { models: [] };
      }
      throw new Error(await this.readError(response, connection.definition.displayName));
    }

    const payload = await response.json().catch(() => ({ data: [] }));
    const models = Array.isArray(payload.data)
      ? payload.data.map(model => mapCompatibleModel(model, connection.definition))
      : [];

    return { models };
  }



  async generateText(connection, options, allowFailure = false) {
    switch (connection.definition.kind) {
      case "lmstudio":
        return null;
      default: {
        const response = await this.sendJson(connection, "POST", "chat/completions", {
          model: options.model,
          messages: buildOpenAiMessages([
            {
              role: "user",
              content: String(options.userPrompt || ""),
              attachments: [],
            },
          ], options.systemPrompt),
          stream: false,
          temperature: options.temperature ?? undefined,
          max_tokens: options.maxTokens ?? undefined,
        }, { allowFailure });

        if (!response.ok) {
          if (allowFailure) {
            return null;
          }
          throw new Error(await this.readError(response, connection.definition.displayName));
        }

        const payload = await response.json().catch(() => null);
        const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
        return extractOpenAiMessageContent(choice?.message?.content);
      }
    }
  }

  async sendJson(connection, method, routePath, body, options = {}) {
    if (!connection.baseUrl) {
      throw new Error(`Set the ${connection.definition.displayName} base URL in Settings first.`);
    }

    const url = new URL(routePath.replace(/^\/+/, ""), ensureTrailingSlash(connection.baseUrl)).toString();
    const headers = {
      Accept: options.acceptEventStream ? "text/event-stream" : "application/json",
    };

    if (connection.apiToken) {
      headers.Authorization = `Bearer ${connection.apiToken.trim()}`;
    }

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetchWithHeadersTimeout(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(stripUndefined(body)),
      signal: options.signal,
    });

    if (!options.allowFailure && !response.ok) {
      throw new Error(await this.readError(response, connection.definition.displayName));
    }

    return response;
  }

  async readError(response, providerLabel) {
    const content = await response.text();
    if (!content.trim()) {
      return `${providerLabel} returned ${response.status} ${response.statusText}.`;
    }

    try {
      const payload = JSON.parse(content);
      const value = payload.error?.message
        || payload.error
        || payload.detail
        || payload.message
        || payload.title
        || content;
      return typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return content;
    }
  }
}

function unsupportedProviderAction(providerLabel, action) {
  const error = new Error(`${providerLabel} does not support ${action} controls.`);
  error.statusCode = 400;
  return error;
}

function ensureTrailingSlash(baseUrl) {
  return String(baseUrl || "").endsWith("/") ? String(baseUrl) : `${baseUrl}/`;
}

async function consumeSseStream(sourceStream, onFrame) {
  const reader = sourceStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  let dataLines = [];

  while (true) {
    const { value, done } = await readWithIdleTimeout(reader);
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r/g, "");

    if (done) {
      buffer += "\n\n";
    }

    let boundaryIndex = buffer.indexOf("\n");
    while (boundaryIndex >= 0) {
      const line = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 1);

      if (line.length === 0) {
        if (eventType || dataLines.length > 0) {
          await onFrame({
            eventType,
            payload: dataLines.join("\n"),
          });
        }

        eventType = "";
        dataLines = [];
      } else if (line.toLowerCase().startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.toLowerCase().startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }

      boundaryIndex = buffer.indexOf("\n");
    }

    if (done) {
      break;
    }
  }
}

function buildLmStudioInput(input, attachments) {
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const imageAttachments = safeAttachments.filter(attachment => String(attachment.kind).toLowerCase() === "image" && attachment.dataUrl);
  const fileAttachments = safeAttachments.filter(attachment => String(attachment.kind).toLowerCase() !== "image");

  let promptText = String(input || "").trim();
  if (!promptText && safeAttachments.length > 0) {
    if (imageAttachments.length > 0 && fileAttachments.length > 0) {
      promptText = "Please analyze the attached content and files.";
    } else if (imageAttachments.length > 0) {
      promptText = "Please analyze the attached image.";
    } else {
      promptText = "Please use the attached file as context.";
    }
  }

  let prompt = promptText;
  if (fileAttachments.length > 0) {
    prompt += "\n\nAttached file context:";
    for (const attachment of fileAttachments) {
      prompt += `\n\n${buildFileAttachmentPromptBlock(attachment)}`;
    }
  }

  if (imageAttachments.length === 0) {
    return prompt;
  }

  return [
    { type: "text", content: prompt },
    ...imageAttachments.map(attachment => ({ type: "image", data_url: attachment.dataUrl })),
  ];
}

function buildOpenAiMessages(messages, systemPrompt) {
  const payload = [];
  if (systemPrompt) {
    payload.push({ role: "system", content: String(systemPrompt) });
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message.role === "assistant") {
      payload.push({
        role: "assistant",
        content: String(message.content || ""),
      });
      continue;
    }

    if (message.role !== "user") {
      continue;
    }

    payload.push({
      role: "user",
      content: buildOpenAiUserContent(message.content, message.attachments),
    });
  }

  return payload;
}



function buildOpenAiUserContent(content, attachments) {
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const imageAttachments = safeAttachments.filter(attachment => String(attachment.kind).toLowerCase() === "image" && attachment.dataUrl);
  const fileAttachments = safeAttachments.filter(attachment => String(attachment.kind).toLowerCase() !== "image");
  const promptText = buildPromptText(content, safeAttachments);
  const promptBlocks = [{ type: "text", text: buildPromptWithFiles(promptText, fileAttachments) }];

  for (const attachment of imageAttachments) {
    promptBlocks.push({
      type: "image_url",
      image_url: { url: attachment.dataUrl },
    });
  }

  return promptBlocks.length === 1 && imageAttachments.length === 0
    ? promptBlocks[0].text
    : promptBlocks;
}



function buildPromptText(content, attachments) {
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const imageAttachments = safeAttachments.filter(attachment => String(attachment.kind).toLowerCase() === "image" && attachment.dataUrl);
  const fileAttachments = safeAttachments.filter(attachment => String(attachment.kind).toLowerCase() !== "image");
  const promptContent = String(content || "").trim();
  if (promptContent) {
    return promptContent;
  }

  if (imageAttachments.length > 0 && fileAttachments.length > 0) {
    return "Please analyze the attached content and files.";
  }
  if (imageAttachments.length > 0) {
    return "Please analyze the attached image.";
  }
  return "Please use the attached file as context.";
}

function buildPromptWithFiles(promptText, attachments) {
  const fileAttachments = Array.isArray(attachments) ? attachments : [];
  if (fileAttachments.length === 0) {
    return String(promptText || "");
  }

  let prompt = String(promptText || "");
  prompt += "\n\nAttached file context:";
  for (const attachment of fileAttachments) {
    prompt += `\n\n${buildFileAttachmentPromptBlock(attachment)}`;
  }
  return prompt;
}

function buildFileAttachmentPromptBlock(attachment) {
  const lines = [`File: ${attachment.name}${attachment.contentType ? ` (${attachment.contentType})` : ""}`];
  if (attachment.textContent) {
    lines.push("```text", String(attachment.textContent).trimEnd(), "```");
    if (attachment.truncated) {
      lines.push("File content was truncated before sending.");
    }
  } else {
    lines.push("Binary file attached. Text extraction was not available.");
  }

  return lines.join("\n").trimEnd();
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    mediaType: match[1],
    base64: match[2],
  };
}

function normalizeOpenAiDelta(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          return String(item.text || item.content || "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stripUndefined(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    output[key] = entry;
  }
  return output;
}

function extractOpenAiMessageContent(content) {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map(item => String(item?.text || item?.content || ""))
    .join("")
    .trim();
  return text || null;
}

function mapCompatibleModel(model, definition) {
  const key = String(model?.id || "").trim();
  return {
    key,
    displayName: key,
    type: "chat",
    publisher: definition.displayName,
    architecture: null,
    quantization: null,
    sizeBytes: null,
    paramsString: null,
    maxContextLength: null,
    format: null,
    loadedInstances: [],
    capabilities: {
      vision: /vision|vl|gemini|gpt-4o|claude-3/i.test(key),
      trainedForToolUse: false,
      reasoning: null,
    },
    variants: [],
    selectedVariant: null,
    description: String(model?.description || "").trim() || null,
  };
}

function mergeUsage(current, next) {
  if (!next || typeof next !== "object") {
    return current;
  }

  return {
    input_tokens: Number.isFinite(Number(next.input_tokens)) ? Number(next.input_tokens) : current?.input_tokens ?? null,
    output_tokens: Number.isFinite(Number(next.output_tokens)) ? Number(next.output_tokens) : current?.output_tokens ?? null,
  };
}

// llama.cpp and LM Studio's server accept these non-standard sampling extensions
// on their OpenAI-compatible endpoint. Strict servers never see them: each field
// is omitted unless the user explicitly set a value.
function reasoningEffortField(value) {
  const effort = String(value || "").trim().toLowerCase();
  return effort && !["default", "off", "none"].includes(effort) ? { reasoning_effort: effort } : {};
}

// One streamed round-trip of the OpenAI-compatible tool loop. Deltas for text and
// reasoning are relayed live; tool_calls deltas are fragments that must be
// accumulated by index (the spec streams name and argument pieces separately).
async function streamSingleRound(providerClient, connection, request, messages, toolRegistry, isFirstRound, signal, onEvent, markDeltaTiming) {
  const response = await providerClient.sendJson(connection, "POST", "chat/completions", {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: request.temperature ?? undefined,
    top_p: request.topP ?? undefined,
    top_k: request.topK ?? undefined,
    min_p: request.minP ?? undefined,
    repeat_penalty: request.repeatPenalty ?? undefined,
    ...reasoningEffortField(request.reasoning),
    ...(toolRegistry && toolRegistry.tools.length > 0 ? { tools: toolRegistry.tools } : {}),
  }, {
    acceptEventStream: true,
    signal,
    allowFailure: true,
  });

  if (!response.ok) {
    throw new Error(await providerClient.readError(response, connection.definition.displayName));
  }

  if (isFirstRound) {
    await onEvent("chat.start", JSON.stringify({ model: request.model, provider: connection.providerId }));
  }

  let responseId = null;
  let usage = null;
  const reasoning = [];
  const content = [];
  const toolCallsByIndex = new Map();

  await consumeSseStream(response.body, async frame => {
    const payload = String(frame.payload || "").trim();
    if (!payload || payload === "[DONE]") {
      return;
    }

    const parsed = safeParseJson(payload);
    if (!parsed) {
      return;
    }

    responseId = parsed.id || responseId;
    usage = parsed.usage || usage;

    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const delta = choice?.delta || {};
    const reasoningDelta = normalizeOpenAiDelta(delta.reasoning_content ?? delta.reasoning ?? delta.reasoningContent ?? null);
    const contentDelta = normalizeOpenAiDelta(delta.content);

    if (reasoningDelta || contentDelta || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)) {
      markDeltaTiming();
    }

    if (reasoningDelta) {
      reasoning.push(reasoningDelta);
      await onEvent("reasoning.delta", JSON.stringify({ content: reasoningDelta }));
    }

    if (contentDelta) {
      content.push(contentDelta);
      await onEvent("message.delta", JSON.stringify({ content: contentDelta }));
    }

    for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(fragment?.index) ? fragment.index : toolCallsByIndex.size;
      const entry = toolCallsByIndex.get(index) || { id: "", name: "", arguments: "" };
      entry.id = fragment?.id || entry.id;
      entry.name = fragment?.function?.name || entry.name;
      entry.arguments += typeof fragment?.function?.arguments === "string" ? fragment.function.arguments : "";
      toolCallsByIndex.set(index, entry);
    }
  });

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, entry], position) => ({
      id: entry.id || `call_${position + 1}`,
      name: entry.name,
      arguments: entry.arguments,
    }))
    .filter(entry => entry.name);

  return { responseId, usage, reasoning: reasoning.join(""), content: content.join(""), toolCalls };
}

function accumulateUsage(totals, usage) {
  const inputTokens = firstFiniteNumber(usage?.input_tokens ?? usage?.prompt_tokens);
  const outputTokens = firstFiniteNumber(usage?.output_tokens ?? usage?.completion_tokens);
  const cachedTokens = firstFiniteNumber(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.cached_tokens);

  if (typeof inputTokens === "number") {
    totals.input_tokens = (totals.input_tokens ?? 0) + inputTokens;
  }

  if (typeof outputTokens === "number") {
    totals.output_tokens = (totals.output_tokens ?? 0) + outputTokens;
  }

  if (typeof cachedTokens === "number") {
    totals.cached_input_tokens = (totals.cached_input_tokens ?? 0) + cachedTokens;
  }
}

// Builds the flattened tools payload from every selected MCP server. OpenAI-style
// endpoints require ^[a-zA-Z0-9_-]{1,64}$ function names, so server tools are
// namespaced as `<serverId>__<tool>` and resolved back on call. An unreachable
// selected server fails the request rather than silently dropping its tools.
async function buildToolRegistry(servers, signal) {
  const tools = [];
  const byExposedName = new Map();

  for (const server of servers) {
    const serverPrefix = sanitizeToolName(server.Label || server.Id);
    const serverTools = await listMcpTools(server, signal);

    for (const tool of serverTools) {
      let exposedName = `${serverPrefix}__${sanitizeToolName(tool.name)}`;
      if (exposedName.length > 64) {
        exposedName = exposedName.slice(0, 64);
      }

      while (byExposedName.has(exposedName)) {
        exposedName = `${exposedName.slice(0, 61)}_x`;
      }

      tools.push({
        type: "function",
        function: {
          name: exposedName,
          description: `${tool.description || tool.name} (from MCP server "${server.Label}")`.slice(0, 1024),
          parameters: tool.inputSchema,
        },
      });

      byExposedName.set(exposedName, {
        server,
        toolName: tool.name,
        displayName: `${server.Label}/${tool.name}`,
      });
    }
  }

  return {
    tools,
    resolve(exposedName) {
      return byExposedName.get(exposedName) || null;
    },
  };
}

async function callMcpTool(server, toolName, args, signal) {
  return await runMcpTool(server, toolName, args, signal);
}

function sanitizeToolName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "mcp";
}

function createAbortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function buildFinalResponse(options) {
  const output = [];
  if (options.reasoning) {
    output.push({ type: "reasoning", content: options.reasoning });
  }
  for (const entry of options.toolCalls || []) {
    output.push({
      type: "tool_call",
      tool: entry.tool,
      arguments: entry.arguments,
      output: entry.output,
      provider_info: { type: "plugin", id: `mcp/${entry.tool}` },
    });
  }
  if (options.content) {
    output.push({ type: "message", content: options.content });
  }

  return {
    output,
    stats: buildStreamStats(options.usage, options.timings),
    response_id: options.responseId || null,
    model_info: {
      context_length: options.contextLength ?? null,
    },
  };
}

// Decode speed mirrors the LM Studio stats semantics: output tokens divided by the
// token-generation window (first delta to last delta), so prompt processing and
// time-to-first-token are excluded. When a provider omits usage, the token counts
// and tokens_per_second stay null rather than being estimated.
function buildStreamStats(usage, timings) {
  if (!usage && !timings) {
    return null;
  }

  const inputTokens = firstFiniteNumber(usage?.input_tokens ?? usage?.prompt_tokens);
  const outputTokens = firstFiniteNumber(usage?.output_tokens ?? usage?.completion_tokens);
  const decodeSeconds = timings && typeof timings.decodeActiveMs === "number"
    ? timings.decodeActiveMs / 1000
    : null;
  const tokensPerSecond = typeof outputTokens === "number" && outputTokens > 0 && typeof decodeSeconds === "number" && decodeSeconds > 0
    ? outputTokens / decodeSeconds
    : null;
  const timeToFirstTokenSeconds = timings && typeof timings.firstDeltaAtMs === "number" && typeof timings.streamStartedAtMs === "number"
    ? Math.max((timings.firstDeltaAtMs - timings.streamStartedAtMs) / 1000, 0)
    : null;
  const promptPerSecond = derivePromptPerSecond(inputTokens, timeToFirstTokenSeconds);
  // Prefix-cache telemetry: llama.cpp and OpenAI-compatible endpoints report how
  // many prompt tokens were served from the KV cache. A cache miss reads as 0,
  // a provider that never reports it as null — the two must stay distinguishable.
  const cachedInputTokens = firstFiniteNumber(
    usage?.cached_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.cached_tokens);

  const stats = {
    input_tokens: inputTokens,
    total_output_tokens: outputTokens,
    tokens_per_second: tokensPerSecond,
    time_to_first_token_seconds: timeToFirstTokenSeconds,
    prompt_per_second: promptPerSecond,
    cached_input_tokens: cachedInputTokens,
  };

  return Object.values(stats).some(value => value !== null) ? stats : null;
}

// Prefill rate is not reported natively by any provider; it is estimated as
// prompt tokens over time-to-first-token. That window includes queueing and, on a
// cold lazy-load slot, model load time, so the estimate reads low in those cases.
function derivePromptPerSecond(inputTokens, timeToFirstTokenSeconds) {
  if (typeof inputTokens !== "number" || inputTokens <= 0) {
    return null;
  }
  if (typeof timeToFirstTokenSeconds !== "number" || timeToFirstTokenSeconds <= MIN_DECODE_WINDOW_MS / 1000) {
    return null;
  }

  return inputTokens / timeToFirstTokenSeconds;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function buildAdaptiveMemoryPrompt(options) {
  const existingSummary = String(options?.existingSummary || "").trim();
  const messages = Array.isArray(options?.messages) ? options.messages : [];
  const parts = [];

  parts.push("Existing memory profile:");
  parts.push(existingSummary || "- None yet.");
  parts.push("");
  parts.push("New user messages since the last review:");

  for (const message of messages) {
    const title = String(message?.chatTitle || "Untitled chat").trim();
    const createdAt = String(message?.createdAt || "").trim();
    const content = String(message?.content || "").trim();
    if (!content) {
      continue;
    }
    parts.push(`- [${createdAt || "unknown time"}] ${title}: ${content}`);
  }

  parts.push("");
  parts.push("Revise the memory profile so it stays compact, factual, and directly useful for future assistant behavior.");
  return parts.join("\n").trim();
}

function truncateWords(text, maxWords) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(" ");
  }

  return words.slice(0, maxWords).join(" ");
}



module.exports = {
  ProviderClient,
};