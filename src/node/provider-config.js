const PROVIDER_DEFINITIONS = [
  {
    id: "lmstudio",
    displayName: "LM Studio",
    kind: "lmstudio",
    defaultBaseUrl: "http://127.0.0.1:1234",
    baseUrlPlaceholder: "http://127.0.0.1:1234",
    modelPlaceholder: "Select a local LM Studio model",
    supportsModelLoad: true,
    supportsMcp: true,
  },
  {
    id: "openai",
    displayName: "OpenAI Compatible",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1/",
    baseUrlPlaceholder: "https://api.openai.com/v1/",
    modelPlaceholder: "gpt-4.1-mini",
    supportsModelLoad: false,
    supportsMcp: true,
  },
  {
    id: "hermes-agent",
    displayName: "Hermes Agent",
    kind: "openai-compatible",
    defaultBaseUrl: "",
    baseUrlPlaceholder: "https://your-hermes-endpoint.example/v1/",
    modelPlaceholder: "hermes-3-llama-3.1-70b",
    supportsModelLoad: false,
    supportsMcp: true,
  },
];

function normalizeProviderId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return PROVIDER_DEFINITIONS.some(definition => definition.id === normalized)
    ? normalized
    : "lmstudio";
}

function getProviderDefinition(providerId) {
  const normalized = normalizeProviderId(providerId);
  return PROVIDER_DEFINITIONS.find(definition => definition.id === normalized) || PROVIDER_DEFINITIONS[0];
}

function listProviderDefinitions() {
  return PROVIDER_DEFINITIONS.map(definition => ({ ...definition }));
}

function getDefaultProviderProfiles() {
  const profiles = {};
  for (const definition of PROVIDER_DEFINITIONS) {
    profiles[definition.id] = {
      BaseUrl: definition.defaultBaseUrl,
      ApiToken: "",
    };
  }

  return profiles;
}

function buildEmptyChatDefaults() {
  return {
    ModelKey: "",
    SystemPrompt: "",
    Reasoning: "",
    ContextLength: null,
    Temperature: null,
    TopK: null,
    TopP: null,
    MinP: null,
    RepeatPenalty: null,
  };
}

function getDefaultChatDefaultsByProvider() {
  const defaults = {};
  for (const definition of PROVIDER_DEFINITIONS) {
    defaults[definition.id] = buildEmptyChatDefaults();
  }

  return defaults;
}

function normalizeProviderProfile(definition, profile, legacyLmStudio) {
  const currentProfile = profile && typeof profile === "object" ? profile : {};
  const legacyProfile = definition.id === "lmstudio" && legacyLmStudio && typeof legacyLmStudio === "object"
    ? legacyLmStudio
    : {};

  return {
    BaseUrl: String(currentProfile.BaseUrl ?? currentProfile.baseUrl ?? legacyProfile.BaseUrl ?? legacyProfile.baseUrl ?? definition.defaultBaseUrl ?? "").trim(),
    ApiToken: String(currentProfile.ApiToken ?? currentProfile.apiToken ?? legacyProfile.ApiToken ?? legacyProfile.apiToken ?? "").trim(),
  };
}

function toOptionalInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toOptionalFloat(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeChatDefaultsEntry(entry, fallback = null) {
  const source = entry && typeof entry === "object"
    ? entry
    : fallback && typeof fallback === "object"
      ? fallback
      : {};

  return {
    ModelKey: String(source.ModelKey ?? source.modelKey ?? "").trim(),
    SystemPrompt: String(source.SystemPrompt ?? source.systemPrompt ?? ""),
    Reasoning: String(source.Reasoning ?? source.reasoning ?? "").trim(),
    ContextLength: toOptionalInteger(source.ContextLength ?? source.contextLength),
    Temperature: toOptionalFloat(source.Temperature ?? source.temperature),
    TopK: toOptionalInteger(source.TopK ?? source.topK),
    TopP: toOptionalFloat(source.TopP ?? source.topP),
    MinP: toOptionalFloat(source.MinP ?? source.minP),
    RepeatPenalty: toOptionalFloat(source.RepeatPenalty ?? source.repeatPenalty),
  };
}

function normalizeChatDefaultsByProvider(chatDefaultsByProvider, legacyChatDefaults) {
  const source = chatDefaultsByProvider && typeof chatDefaultsByProvider === "object"
    ? chatDefaultsByProvider
    : {};
  const normalized = {};

  for (const definition of PROVIDER_DEFINITIONS) {
    normalized[definition.id] = normalizeChatDefaultsEntry(
      source[definition.id],
      definition.id === "lmstudio" ? legacyChatDefaults : null
    );
  }

  return normalized;
}

function normalizeProviderConfiguration(config) {
  const next = config && typeof config === "object" ? { ...config } : {};
  const rawProviders = next.Providers?.Profiles && typeof next.Providers.Profiles === "object"
    ? next.Providers.Profiles
    : {};
  const profiles = getDefaultProviderProfiles();

  for (const definition of PROVIDER_DEFINITIONS) {
    profiles[definition.id] = normalizeProviderProfile(definition, rawProviders[definition.id], next.LmStudio);
  }

  const activeProvider = normalizeProviderId(next.Providers?.ActiveProvider ?? next.Providers?.Active ?? "lmstudio");
  const chatDefaultsByProvider = normalizeChatDefaultsByProvider(next.Ui?.ChatDefaultsByProvider, next.Ui?.ChatDefaults);

  next.Providers = {
    ...(next.Providers || {}),
    ActiveProvider: activeProvider,
    Profiles: profiles,
  };
  next.LmStudio = { ...profiles.lmstudio };
  next.Ui = {
    ...(next.Ui || {}),
    ChatDefaultsByProvider: chatDefaultsByProvider,
    ChatDefaults: chatDefaultsByProvider[activeProvider],
  };

  return next;
}

function getActiveProviderId(config) {
  return normalizeProviderId(config?.Providers?.ActiveProvider ?? config?.Providers?.Active ?? "lmstudio");
}

function getProviderProfile(config, providerId = null) {
  const definition = getProviderDefinition(providerId || getActiveProviderId(config));
  const rawProfiles = config?.Providers?.Profiles && typeof config.Providers.Profiles === "object"
    ? config.Providers.Profiles
    : {};

  return normalizeProviderProfile(definition, rawProfiles[definition.id], config?.LmStudio);
}

function getProviderConnectionSettings(config, providerId = null) {
  const definition = getProviderDefinition(providerId || getActiveProviderId(config));
  const profile = getProviderProfile(config, definition.id);

  return {
    providerId: definition.id,
    definition,
    baseUrl: profile.BaseUrl,
    apiToken: profile.ApiToken,
  };
}

function getChatDefaultsForProvider(config, providerId = null) {
  const normalizedProviderId = normalizeProviderId(providerId || getActiveProviderId(config));
  const chatDefaultsByProvider = config?.Ui?.ChatDefaultsByProvider && typeof config.Ui.ChatDefaultsByProvider === "object"
    ? config.Ui.ChatDefaultsByProvider
    : {};

  return normalizeChatDefaultsEntry(
    chatDefaultsByProvider[normalizedProviderId],
    normalizedProviderId === "lmstudio" ? config?.Ui?.ChatDefaults : null
  );
}

module.exports = {
  buildEmptyChatDefaults,
  getActiveProviderId,
  getChatDefaultsForProvider,
  getDefaultChatDefaultsByProvider,
  getDefaultProviderProfiles,
  getProviderConnectionSettings,
  getProviderDefinition,
  getProviderProfile,
  listProviderDefinitions,
  normalizeChatDefaultsEntry,
  normalizeChatDefaultsByProvider,
  normalizeProviderConfiguration,
  normalizeProviderId,
};