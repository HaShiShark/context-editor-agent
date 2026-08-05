import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { flushSync } from 'react-dom';

import {
  archiveProjectSessionsRequest,
  cancelActiveRequest,
  createProjectRequest,
  createSessionRequest,
  deleteMessageRequest,
  deleteProjectRequest,
  deleteSessionRequest,
  fetchInit,
  fetchProviderModelCandidatesRequest,
  fetchSettings,
  pinProjectRequest,
  renameProjectRequest,
  saveSettingsRequest,
  sendMessageRequest,
  streamMessageRequest,
  truncateSessionRequest,
} from './api';
import ChatModelPicker from './components/ChatModelPicker';
import ChatView from './components/ChatView';
import ContextMapSidebar from './components/ContextMapSidebar';
import SettingsView from './components/SettingsView';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import {
  ATTACHMENT_READY_TOAST,
  ATTACHMENT_REMOVED_TOAST,
  COLLAPSE_TOAST,
  COPY_TOAST,
  DELETE_CHAT_TOAST,
  EDIT_TOAST,
  EMPTY_SEND_TOAST,
  INITIAL_TOAST_MESSAGE,
  NEW_CHAT_TOAST,
  NEW_PROJECT_TOAST,
  PERMISSION_OPTIONS,
  REGENERATE_MISSING_TOAST,
  REGENERATE_TOAST,
  SENDING_TOAST,
  SETTINGS_API_KEY_CLEARED_TOAST,
  SETTINGS_HINTS_OFF_TOAST,
  SETTINGS_HINTS_ON_TOAST,
  SETTINGS_SAVED_TOAST,
} from './constants';
import type {
  ComposerAttachment,
  ContextWorkbenchHistoryEntry,
  ContextRevisionSummary,
  PendingContextRestore,
  DropdownId,
  InitPayload,
  MessageBlock,
  MessageRecord,
  OpenAISettings,
  PermissionOption,
  ProjectSummary,
  ReasoningOption,
  ResponseProviderDraft,
  ResponseProviderModel,
  ResponseProviderSettings,
  ProviderType,
  SessionSummary,
  SettingsDraft,
  SidebarMode,
  ToolSetting,
  ViewName,
  ContextMapState,
} from './types';
import {
  copyText,
  deriveSidebarState,
  getConversation,
  getProjectById,
  getReasoningLabel,
  getSessionMeta,
  normalizeConversation,
  normalizeReasoningOptions,
} from './utils';
import { localizeAppDom, localizeUiText, normalizeSupportedLocale } from './i18n';

type AppearanceMode = 'light' | 'dark';
type ResolvedAppearanceMode = 'light' | 'dark';

interface PersistedUiPreferences {
  theme_mode: AppearanceMode;
  service_hints_enabled: boolean;
}

function defaultResponseProviderSettings(): ResponseProviderSettings[] {
  return [
    {
      id: 'openai',
      name: 'OpenAI',
      provider_type: 'responses',
      enabled: true,
      supports_model_fetch: true,
      supports_responses: true,
      api_base_url: 'https://api.openai.com/v1',
      default_model: 'gpt-5.4-mini',
      has_api_key: false,
      api_key_preview: '',
      models: [],
      last_sync_at: '',
      last_sync_error: '',
    },
    {
      id: 'anthropic',
      name: 'Claude',
      provider_type: 'claude',
      enabled: true,
      supports_model_fetch: true,
      supports_responses: false,
      api_base_url: 'https://api.anthropic.com/v1',
      default_model: 'claude-sonnet-4-5',
      has_api_key: false,
      api_key_preview: '',
      models: [],
      last_sync_at: '',
      last_sync_error: '',
    },
    {
      id: 'gemini',
      name: 'Gemini',
      provider_type: 'gemini',
      enabled: true,
      supports_model_fetch: true,
      supports_responses: false,
      api_base_url: 'https://generativelanguage.googleapis.com/v1beta',
      default_model: 'gemini-2.5-pro',
      has_api_key: false,
      api_key_preview: '',
      models: [],
      last_sync_at: '',
      last_sync_error: '',
    },
  ];
}

function providerTypeFromUnknown(rawType: unknown, providerId = ''): ProviderType {
  if (
    rawType === 'chat_completion' ||
    rawType === 'responses' ||
    rawType === 'gemini' ||
    rawType === 'claude'
  ) {
    return rawType;
  }
  if (providerId === 'gemini') {
    return 'gemini';
  }
  if (providerId === 'anthropic' || providerId === 'claude') {
    return 'claude';
  }
  return 'responses';
}

function createProviderDraft(
  providerType: ProviderType,
  existingProviders: ResponseProviderDraft[],
  providerName?: string,
): ResponseProviderDraft {
  const count = existingProviders.filter((provider) => provider.provider_type === providerType).length + 1;
  const id = `custom-${providerType}-${Date.now().toString(36)}`;
  const defaults: Record<ProviderType, { name: string; apiBaseUrl: string; defaultModel: string }> = {
    responses: {
      name: `Responses ${count}`,
      apiBaseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-5.4-mini',
    },
    chat_completion: {
      name: `Chat Completion ${count}`,
      apiBaseUrl: 'https://api.example.com/v1',
      defaultModel: 'gpt-4.1-mini',
    },
    gemini: {
      name: `Gemini ${count}`,
      apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: 'gemini-2.5-pro',
    },
    claude: {
      name: `Claude ${count}`,
      apiBaseUrl: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-sonnet-4-5',
    },
  };
  const spec = defaults[providerType];
  const resolvedName = providerName?.trim() || spec.name;

  return {
    id,
    name: resolvedName,
    provider_type: providerType,
    enabled: true,
    supports_model_fetch: true,
    supports_responses: providerType === 'responses',
    api_base_url: spec.apiBaseUrl,
    api_key_input: '',
    clear_api_key: false,
    default_model: spec.defaultModel,
    models: [],
    last_sync_at: '',
    last_sync_error: '',
  };
}

function normalizeResponseProviderSettings(rawProviders: unknown): ResponseProviderSettings[] {
  const defaults = defaultResponseProviderSettings();
  const rawProviderList = Array.isArray(rawProviders) ? rawProviders : [];
  const normalizedDefaultIds = new Set(defaults.map((provider) => provider.id));
  const legacyDefaultIds = new Set(['openrouter', 'newapi', 'siliconflow', 'lmstudio']);

  const normalizedDefaults = defaults.map((defaultProvider) => {
    const matchedProvider = rawProviderList.find((item) => {
      if (!item || typeof item !== 'object') {
        return false;
      }
      return (item as { id?: unknown }).id === defaultProvider.id;
    }) as Partial<ResponseProviderSettings> | undefined;

    return {
      ...defaultProvider,
      ...(matchedProvider || {}),
      id: matchedProvider?.id || defaultProvider.id,
      name: typeof matchedProvider?.name === 'string' && matchedProvider.name ? matchedProvider.name : defaultProvider.name,
      provider_type: providerTypeFromUnknown(matchedProvider?.provider_type, defaultProvider.id),
      enabled: matchedProvider?.enabled ?? defaultProvider.enabled,
      supports_model_fetch: matchedProvider?.supports_model_fetch ?? true,
      supports_responses: providerTypeFromUnknown(matchedProvider?.provider_type, defaultProvider.id) === 'responses',
      api_base_url: typeof matchedProvider?.api_base_url === 'string'
        ? matchedProvider.api_base_url
        : defaultProvider.api_base_url,
      default_model: typeof matchedProvider?.default_model === 'string'
        ? matchedProvider.default_model
        : defaultProvider.default_model,
      has_api_key: Boolean(matchedProvider?.has_api_key),
      api_key_preview: typeof matchedProvider?.api_key_preview === 'string' ? matchedProvider.api_key_preview : '',
      api_key: typeof matchedProvider?.api_key === 'string' ? matchedProvider.api_key : '',
      models: Array.isArray(matchedProvider?.models) ? matchedProvider.models : defaultProvider.models,
      last_sync_at: typeof matchedProvider?.last_sync_at === 'string' ? matchedProvider.last_sync_at : '',
      last_sync_error: typeof matchedProvider?.last_sync_error === 'string' ? matchedProvider.last_sync_error : '',
    };
  });

  const customProviders = rawProviderList.flatMap((item): ResponseProviderSettings[] => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const raw = item as Partial<ResponseProviderSettings>;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || normalizedDefaultIds.has(id) || legacyDefaultIds.has(id)) {
      return [];
    }
    const providerType = providerTypeFromUnknown(raw.provider_type, id);
    return [
      {
        id,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
        provider_type: providerType,
        enabled: raw.enabled ?? true,
        supports_model_fetch: raw.supports_model_fetch ?? true,
        supports_responses: providerType === 'responses',
        api_base_url: typeof raw.api_base_url === 'string' ? raw.api_base_url : '',
        default_model: typeof raw.default_model === 'string' ? raw.default_model : '',
        has_api_key: Boolean(raw.has_api_key),
        api_key_preview: typeof raw.api_key_preview === 'string' ? raw.api_key_preview : '',
        api_key: typeof raw.api_key === 'string' ? raw.api_key : '',
        models: Array.isArray(raw.models) ? raw.models : [],
        last_sync_at: typeof raw.last_sync_at === 'string' ? raw.last_sync_at : '',
        last_sync_error: typeof raw.last_sync_error === 'string' ? raw.last_sync_error : '',
      },
    ];
  });

  return [...normalizedDefaults, ...customProviders];
}

function optionalNumberString(value: number | null | undefined, fallback: string) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;
}

function parseOptionalNumber(value: string, enabled: boolean) {
  if (!enabled) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeBoundedNumber(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function normalizeAppearanceMode(value: unknown): AppearanceMode {
  return value === 'light' || value === 'dark' ? value : DEFAULT_SETTINGS.theme_mode;
}

function normalizeReasoningEffortSetting(value: unknown) {
  return typeof value === 'string' && ['default', 'none', 'low', 'medium', 'high'].includes(value)
    ? value
    : DEFAULT_SETTINGS.default_reasoning_effort;
}

function resolveReasoningEffort(value: string, options: ReasoningOption[]) {
  return options.some((option) => option.value === value)
    ? value
    : options.find((option) => option.value === 'default')?.value || options[0]?.value || DEFAULT_SETTINGS.default_reasoning_effort;
}

function normalizeSettingsPayload(rawSettings: Partial<OpenAISettings> | undefined): OpenAISettings {
  const nextSettings = rawSettings || {};

  return {
    default_model: typeof nextSettings.default_model === 'string' && nextSettings.default_model
      ? nextSettings.default_model
      : DEFAULT_SETTINGS.default_model,
    default_reasoning_effort: normalizeReasoningEffortSetting(nextSettings.default_reasoning_effort),
    context_workbench_model: typeof nextSettings.context_workbench_model === 'string' && nextSettings.context_workbench_model
      ? nextSettings.context_workbench_model
      : DEFAULT_SETTINGS.context_workbench_model,
    context_workbench_provider_id:
      typeof nextSettings.context_workbench_provider_id === 'string' && nextSettings.context_workbench_provider_id
        ? nextSettings.context_workbench_provider_id
        : (typeof nextSettings.active_provider_id === 'string' && nextSettings.active_provider_id
            ? nextSettings.active_provider_id
            : DEFAULT_SETTINGS.context_workbench_provider_id),
    context_token_warning_threshold: typeof nextSettings.context_token_warning_threshold === 'number'
      ? nextSettings.context_token_warning_threshold
      : DEFAULT_SETTINGS.context_token_warning_threshold,
    context_token_critical_threshold: typeof nextSettings.context_token_critical_threshold === 'number'
      ? nextSettings.context_token_critical_threshold
      : DEFAULT_SETTINGS.context_token_critical_threshold,
    openai_base_url: typeof nextSettings.openai_base_url === 'string' ? nextSettings.openai_base_url : '',
    max_tool_rounds: typeof nextSettings.max_tool_rounds === 'number'
      ? nextSettings.max_tool_rounds
      : DEFAULT_SETTINGS.max_tool_rounds,
    assistant_name: typeof nextSettings.assistant_name === 'string' ? nextSettings.assistant_name : DEFAULT_SETTINGS.assistant_name,
    assistant_greeting: typeof nextSettings.assistant_greeting === 'string' ? nextSettings.assistant_greeting : DEFAULT_SETTINGS.assistant_greeting,
    assistant_prompt: typeof nextSettings.assistant_prompt === 'string' ? nextSettings.assistant_prompt : DEFAULT_SETTINGS.assistant_prompt,
    temperature: normalizeOptionalNumber(nextSettings.temperature),
    top_p: normalizeOptionalNumber(nextSettings.top_p),
    context_message_limit: normalizeOptionalNumber(nextSettings.context_message_limit),
    streaming: typeof nextSettings.streaming === 'boolean' ? nextSettings.streaming : DEFAULT_SETTINGS.streaming,
    user_name: typeof nextSettings.user_name === 'string' ? nextSettings.user_name : DEFAULT_SETTINGS.user_name,
    user_locale: normalizeSupportedLocale(nextSettings.user_locale),
    user_timezone: typeof nextSettings.user_timezone === 'string' ? nextSettings.user_timezone : DEFAULT_SETTINGS.user_timezone,
    user_profile: typeof nextSettings.user_profile === 'string' ? nextSettings.user_profile : DEFAULT_SETTINGS.user_profile,
    theme_mode: normalizeAppearanceMode(nextSettings.theme_mode),
    service_hints_enabled: typeof nextSettings.service_hints_enabled === 'boolean'
      ? nextSettings.service_hints_enabled
      : DEFAULT_SETTINGS.service_hints_enabled,
    has_api_key: Boolean(nextSettings.has_api_key),
    api_key_preview: typeof nextSettings.api_key_preview === 'string' ? nextSettings.api_key_preview : '',
    openai_api_key: typeof nextSettings.openai_api_key === 'string' ? nextSettings.openai_api_key : '',
    project_root: typeof nextSettings.project_root === 'string' ? nextSettings.project_root : '',
    active_provider_id: typeof nextSettings.active_provider_id === 'string' && nextSettings.active_provider_id
      ? nextSettings.active_provider_id
      : DEFAULT_SETTINGS.active_provider_id,
    response_providers: normalizeResponseProviderSettings(nextSettings.response_providers),
    tool_settings: normalizeToolSettings(nextSettings.tool_settings),
  };
}

const DEFAULT_TOOL_SETTINGS: ToolSetting[] = [
  { name: 'parallel_tools', label: 'parallel_tools', description: 'Run multiple enabled tools concurrently and return their results together.', enabled: true },
  { name: 'shell_command', label: 'Shell command', description: 'Run a PowerShell command for local inspection, tests, and debugging.', enabled: true },
  { name: 'exec_command', label: 'Exec command', description: 'Start a process and stream its output.', enabled: true },
  { name: 'write_stdin', label: 'Write stdin', description: 'Write input to a running exec process.', enabled: true },
  { name: 'apply_patch', label: 'Apply Patch', description: 'Apply a Codex style patch to workspace files.', enabled: true },
  { name: 'list_dir', label: 'List directory', description: 'List workspace directory contents.', enabled: true },
  { name: 'read_file', label: 'Read file', description: 'Read a text file from the workspace.', enabled: true },
  { name: 'view_image', label: 'View image', description: 'Read a workspace image and return it to the model.', enabled: true },
  { name: 'js_repl', label: 'JS REPL', description: 'Run JavaScript in the local Node.js kernel.', enabled: true },
  { name: 'js_repl_reset', label: 'Reset JS REPL', description: 'Reset the local JavaScript kernel.', enabled: true },
  { name: 'get_current_time', label: 'Current time', description: 'Get the current time for a timezone.', enabled: true },
];

function normalizeToolSettings(rawTools: unknown): ToolSetting[] {
  const rawByName = new Map<string, Partial<ToolSetting>>();
  if (Array.isArray(rawTools)) {
    rawTools.forEach((item) => {
      if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
        rawByName.set((item as { name: string }).name, item as Partial<ToolSetting>);
      }
    });
  }

  return DEFAULT_TOOL_SETTINGS.map((tool) => {
    const raw = rawByName.get(tool.name);
    return {
      name: tool.name,
      label: typeof raw?.label === 'string' && raw.label ? raw.label : tool.label,
      description: typeof raw?.description === 'string' && raw.description ? raw.description : tool.description,
      enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : tool.enabled,
    };
  });
}

const DEFAULT_SETTINGS: OpenAISettings = {
  default_model: 'gpt-5.4-mini',
  default_reasoning_effort: 'default',
  context_workbench_model: 'gpt-5.4-mini',
  context_workbench_provider_id: 'openai',
  context_token_warning_threshold: 5000,
  context_token_critical_threshold: 10000,
  openai_base_url: '',
  max_tool_rounds: 999999,
  assistant_name: 'Hanako',
  assistant_greeting: '先接住上下文，再推进任务。',
  assistant_prompt: '你是一个温和、可靠、说人话的助手。先理解真实意图，再给出清晰直接的建议。',
  temperature: null,
  top_p: null,
  context_message_limit: null,
  streaming: true,
  user_name: '小宝',
  user_locale: 'zh-CN',
  user_timezone: 'Asia/Shanghai',
  user_profile: '希望助手像一个一起做事的搭档，少一点客套，多一点推进。',
  theme_mode: 'light',
  service_hints_enabled: true,
    has_api_key: false,
    api_key_preview: '',
    openai_api_key: '',
    project_root: '',
  active_provider_id: 'openai',
  response_providers: defaultResponseProviderSettings(),
  tool_settings: DEFAULT_TOOL_SETTINGS,
};

function buildConversationMap(rawConversations: InitPayload['conversations']) {
  const nextConversations: Record<string, MessageRecord[]> = {};

  Object.entries(rawConversations || {}).forEach(([sessionId, records]) => {
    nextConversations[sessionId] = normalizeConversation(records);
  });

  return nextConversations;
}

function buildContextWorkbenchHistoryMap(rawHistories: InitPayload['context_workbench_histories']) {
  const nextHistories: Record<string, ContextWorkbenchHistoryEntry[]> = {};

  Object.entries(rawHistories || {}).forEach(([sessionId, entries]) => {
    if (!Array.isArray(entries)) {
      return;
    }

    const safeEntries = entries
      .filter((entry): entry is ContextWorkbenchHistoryEntry => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }

        return (
          (entry.role === 'user' || entry.role === 'assistant') &&
          typeof entry.content === 'string' &&
          entry.content.trim().length > 0
        );
      })
      .map((entry) => ({
        role: entry.role,
        content: entry.content,
      }));

    if (safeEntries.length) {
      nextHistories[sessionId] = safeEntries;
    }
  });

  return nextHistories;
}

function buildContextRevisionHistoryMap(rawHistories: InitPayload['context_revision_histories']) {
  const nextHistories: Record<string, ContextRevisionSummary[]> = {};

  Object.entries(rawHistories || {}).forEach(([sessionId, entries]) => {
    if (!Array.isArray(entries)) {
      return;
    }

    const safeEntries = entries
      .filter((entry): entry is ContextRevisionSummary => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }

        return (
          typeof entry.id === 'string' &&
          typeof entry.label === 'string' &&
          typeof entry.created_at === 'string' &&
          typeof entry.operation_count === 'number' &&
          typeof entry.node_count === 'number'
        );
      })
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        summary: typeof entry.summary === 'string' ? entry.summary : entry.label,
        created_at: entry.created_at,
        revision_number: typeof entry.revision_number === 'number' ? entry.revision_number : 0,
        change_type: typeof entry.change_type === 'string' ? entry.change_type : 'update',
        change_types: Array.isArray(entry.change_types)
          ? entry.change_types.filter((item): item is string => typeof item === 'string')
          : [],
        changed_nodes: Array.isArray(entry.changed_nodes)
          ? entry.changed_nodes
              .map((item) => Number(item))
              .filter((item) => Number.isFinite(item) && item > 0)
          : [],
        is_active: Boolean(entry.is_active),
        operation_count: entry.operation_count,
        node_count: entry.node_count,
      }));

    if (safeEntries.length) {
      nextHistories[sessionId] = safeEntries;
    }
  });

  return nextHistories;
}

function buildPendingContextRestoreMap(rawRestores: InitPayload['pending_context_restores']) {
  const nextRestores: Record<string, PendingContextRestore> = {};

  Object.entries(rawRestores || {}).forEach(([sessionId, entry]) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }

    if (
      typeof entry.target_revision_id !== 'string' ||
      typeof entry.target_label !== 'string' ||
      typeof entry.created_at !== 'string' ||
      typeof entry.can_undo !== 'boolean'
    ) {
      return;
    }

    nextRestores[sessionId] = {
      target_revision_id: entry.target_revision_id,
      target_label: entry.target_label,
      created_at: entry.created_at,
      undo_active_revision_id:
        typeof entry.undo_active_revision_id === 'string' ? entry.undo_active_revision_id : undefined,
      can_undo: entry.can_undo,
    };
  });

  return nextRestores;
}

function toSettingsDraft(settings: OpenAISettings): SettingsDraft {
  const normalizedSettings = normalizeSettingsPayload(settings);
  const responseProviders = normalizedSettings.response_providers;

  return {
    openai_api_key: normalizedSettings.openai_api_key || '',
    openai_base_url: normalizedSettings.openai_base_url || '',
    default_model: normalizedSettings.default_model || 'gpt-5.4-mini',
    max_tool_rounds: normalizedSettings.max_tool_rounds || 6,
    assistant_name: normalizedSettings.assistant_name,
    assistant_greeting: normalizedSettings.assistant_greeting,
    assistant_prompt: normalizedSettings.assistant_prompt,
    temperature: optionalNumberString(normalizedSettings.temperature, '0.7'),
    temperature_enabled: normalizedSettings.temperature !== null,
    top_p: optionalNumberString(normalizedSettings.top_p, '1'),
    top_p_enabled: normalizedSettings.top_p !== null,
    context_message_limit: optionalNumberString(normalizedSettings.context_message_limit, '40'),
    context_message_limit_enabled: normalizedSettings.context_message_limit !== null,
    streaming: normalizedSettings.streaming,
    user_name: normalizedSettings.user_name,
    user_locale: normalizedSettings.user_locale,
    user_timezone: normalizedSettings.user_timezone,
    user_profile: normalizedSettings.user_profile,
    active_provider_id: normalizedSettings.active_provider_id || 'openai',
    tool_settings: normalizeToolSettings(normalizedSettings.tool_settings),
    response_providers: responseProviders.map((provider): ResponseProviderDraft => ({
      id: provider.id,
      name: provider.name,
      provider_type: provider.provider_type,
      enabled: provider.enabled,
      supports_model_fetch: provider.supports_model_fetch,
      supports_responses: provider.supports_responses,
      api_base_url: provider.api_base_url || '',
      api_key_input: provider.api_key || '',
      clear_api_key: false,
      default_model: provider.default_model || '',
      models: Array.isArray(provider.models) ? provider.models : [],
      last_sync_at: provider.last_sync_at || '',
      last_sync_error: provider.last_sync_error || '',
    })),
  };
}

type EditableTextDraftField =
  | 'assistant_name'
  | 'assistant_greeting'
  | 'assistant_prompt'
  | 'user_name'
  | 'user_timezone'
  | 'user_profile';

const editableTextDraftFields: EditableTextDraftField[] = [
  'assistant_name',
  'assistant_greeting',
  'assistant_prompt',
  'user_name',
  'user_timezone',
  'user_profile',
];

function applyEditableTextOverrides(
  draft: SettingsDraft,
  overrides: Partial<Record<EditableTextDraftField, string>>,
): SettingsDraft {
  return {
    ...draft,
    ...overrides,
  };
}

function preserveEditableDraftFields(nextDraft: SettingsDraft, currentDraft: SettingsDraft): SettingsDraft {
  const currentProviders = new Map(currentDraft.response_providers.map((provider) => [provider.id, provider]));

  return {
    ...nextDraft,
    openai_base_url: currentDraft.openai_base_url,
    assistant_name: currentDraft.assistant_name,
    assistant_greeting: currentDraft.assistant_greeting,
    assistant_prompt: currentDraft.assistant_prompt,
    temperature: currentDraft.temperature,
    top_p: currentDraft.top_p,
    context_message_limit: currentDraft.context_message_limit,
    user_name: currentDraft.user_name,
    user_locale: currentDraft.user_locale,
    user_timezone: currentDraft.user_timezone,
    user_profile: currentDraft.user_profile,
    response_providers: nextDraft.response_providers.map((provider) => {
      const currentProvider = currentProviders.get(provider.id);
      if (!currentProvider) {
        return provider;
      }

      return {
        ...provider,
        name: currentProvider.name,
        api_base_url: currentProvider.api_base_url,
        default_model: currentProvider.default_model,
      };
    }),
  };
}

function buildSettingsSavePayload(
  draft: SettingsDraft,
  options: {
    activeProviderId?: string;
    clearProviderApiKeyId?: string;
    defaultReasoningEffort?: string;
    uiPreferences?: PersistedUiPreferences;
  } = {},
) {
  const effectiveActiveProviderId = options.activeProviderId || draft.active_provider_id;
  const effectiveActiveProvider = draft.response_providers.find((provider) => provider.id === effectiveActiveProviderId);

  return {
    default_model: effectiveActiveProvider?.default_model || draft.default_model,
    ...(options.defaultReasoningEffort !== undefined
      ? { default_reasoning_effort: options.defaultReasoningEffort }
      : {}),
    openai_base_url: (effectiveActiveProvider?.api_base_url || draft.openai_base_url).trim(),
    max_tool_rounds: draft.max_tool_rounds,
    assistant_name: draft.assistant_name,
    assistant_greeting: draft.assistant_greeting,
    assistant_prompt: draft.assistant_prompt,
    temperature: parseOptionalNumber(draft.temperature, draft.temperature_enabled),
    top_p: parseOptionalNumber(draft.top_p, draft.top_p_enabled),
    context_message_limit: parseOptionalNumber(draft.context_message_limit, draft.context_message_limit_enabled),
    streaming: draft.streaming,
    user_name: draft.user_name,
    user_locale: normalizeSupportedLocale(draft.user_locale),
    user_timezone: draft.user_timezone,
    user_profile: draft.user_profile,
    tool_settings: normalizeToolSettings(draft.tool_settings),
    active_provider_id: effectiveActiveProviderId,
    response_providers: draft.response_providers.map((provider) => {
      const payload: {
        id: string;
        name: string;
        provider_type: ProviderType;
        enabled: boolean;
        supports_model_fetch: boolean;
        supports_responses: boolean;
        api_base_url: string;
        default_model: string;
        models: ResponseProviderDraft['models'];
        last_sync_at: string;
        last_sync_error: string;
        api_key?: string;
        clear_api_key?: boolean;
      } = {
        id: provider.id,
        name: provider.name,
        provider_type: provider.provider_type,
        enabled: provider.enabled,
        supports_model_fetch: provider.supports_model_fetch,
        supports_responses: provider.supports_responses,
        api_base_url: provider.api_base_url.trim(),
        default_model: provider.default_model,
        models: provider.models,
        last_sync_at: provider.last_sync_at,
        last_sync_error: provider.last_sync_error,
      };

      const typedApiKey = provider.api_key_input.trim();
      if (typedApiKey) {
        payload.api_key = typedApiKey;
      }
      if (provider.clear_api_key || options.clearProviderApiKeyId === provider.id) {
        payload.clear_api_key = true;
      }
      return payload;
    }),
    ...((effectiveActiveProvider?.api_key_input || draft.openai_api_key).trim()
      ? { openai_api_key: (effectiveActiveProvider?.api_key_input || draft.openai_api_key).trim() }
      : {}),
    ...(options.uiPreferences || {}),
  };
}

function uiPreferencesFromSettings(settings: OpenAISettings): PersistedUiPreferences {
  return {
    theme_mode: settings.theme_mode,
    service_hints_enabled: settings.service_hints_enabled,
  };
}

function settingsPayloadSnapshot(payload: unknown) {
  return JSON.stringify(payload);
}

function removeProviderFromDraft(draft: SettingsDraft, providerId: string): SettingsDraft {
  const nextProviders = draft.response_providers.filter((provider) => provider.id !== providerId);
  const nextActiveProvider = nextProviders.find((provider) => provider.id === draft.active_provider_id) || nextProviders[0];

  return {
    ...draft,
    active_provider_id: nextActiveProvider?.id || '',
    response_providers: nextProviders,
    default_model: nextActiveProvider?.default_model || draft.default_model,
    openai_base_url: nextActiveProvider?.api_base_url || draft.openai_base_url,
    openai_api_key: nextActiveProvider?.id === draft.active_provider_id ? draft.openai_api_key : '',
  };
}

function applyProviderModelSelection(draft: SettingsDraft, providerId: string, modelId: string): SettingsDraft {
  const nextProviders = draft.response_providers.map((provider) =>
    provider.id === providerId
      ? {
          ...provider,
          default_model: modelId,
        }
      : provider,
  );
  const nextActiveProvider = nextProviders.find((provider) => provider.id === providerId) || nextProviders[0];

  return {
    ...draft,
    active_provider_id: nextActiveProvider?.id || draft.active_provider_id,
    response_providers: nextProviders,
    default_model: modelId,
    openai_base_url: nextActiveProvider?.api_base_url || draft.openai_base_url,
    openai_api_key: nextActiveProvider?.id === draft.active_provider_id ? draft.openai_api_key : '',
  };
}

function toMessageAttachments(attachments: ComposerAttachment[]) {
  return attachments.map(({ data_url, ...attachment }) => ({
    ...attachment,
    url: data_url,
  }));
}

function createAttachmentId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createTextBlock(text: string): MessageBlock {
  return {
    kind: 'text',
    text,
  };
}

function createReasoningBlock(text = '', status: 'streaming' | 'completed' = 'streaming'): MessageBlock {
  return {
    kind: 'reasoning',
    text,
    status,
  };
}

function createThinkingBlock(): MessageBlock {
  return {
    kind: 'thinking',
  };
}

function startThinkingBlock(blocks: MessageBlock[]): MessageBlock[] {
  if (blocks.some((block) => block.kind === 'thinking')) {
    return blocks;
  }

  return [...blocks, createThinkingBlock()];
}

function removeThinkingBlocks(blocks: MessageBlock[]): MessageBlock[] {
  return blocks.filter((block) => block.kind !== 'thinking');
}

function appendDeltaToBlocks(blocks: MessageBlock[], delta: string): MessageBlock[] {
  if (!delta) {
    return blocks;
  }

  const nextBlocks = removeThinkingBlocks(blocks);
  const lastBlock = nextBlocks[nextBlocks.length - 1];

  if (lastBlock?.kind === 'text') {
    nextBlocks[nextBlocks.length - 1] = {
      kind: 'text',
      text: `${lastBlock.text}${delta}`,
    };
    return nextBlocks;
  }

  nextBlocks.push(createTextBlock(delta));
  return nextBlocks;
}

function findStreamingReasoningBlockIndex(blocks: MessageBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind === 'reasoning' && block.status === 'streaming') {
      return index;
    }
  }

  return -1;
}

function startReasoningBlock(blocks: MessageBlock[]): MessageBlock[] {
  const activeReasoningIndex = findStreamingReasoningBlockIndex(blocks);
  if (activeReasoningIndex >= 0) {
    return blocks;
  }

  const activeThinkingIndex = blocks.findIndex((block) => block.kind === 'thinking');
  if (activeThinkingIndex >= 0) {
    return blocks.map((block, index) => (
      index === activeThinkingIndex ? createReasoningBlock() : block
    ));
  }

  return [...removeThinkingBlocks(blocks), createReasoningBlock()];
}

function appendReasoningDeltaToBlocks(blocks: MessageBlock[], delta: string): MessageBlock[] {
  if (!delta) {
    return blocks;
  }

  const nextBlocks = startReasoningBlock(blocks);
  const activeReasoningIndex = findStreamingReasoningBlockIndex(nextBlocks);

  if (activeReasoningIndex < 0) {
    return nextBlocks;
  }

  const block = nextBlocks[activeReasoningIndex];
  if (block.kind !== 'reasoning') {
    return nextBlocks;
  }

  return nextBlocks.map((item, index) => (
    index === activeReasoningIndex
      ? {
          ...block,
          text: `${block.text}${delta}`,
          status: 'streaming',
        }
      : item
  ));
}

function completeReasoningBlocks(blocks: MessageBlock[]): MessageBlock[] {
  return removeThinkingBlocks(blocks)
    .map((block) => (
      block.kind === 'reasoning' && block.status === 'streaming'
        ? {
            ...block,
            status: 'completed',
          }
        : block
    ))
    .filter((block) => !(block.kind === 'reasoning' && !block.text.trim() && block.status !== 'streaming'));
}

function appendToolToBlocks(blocks: MessageBlock[], toolEvent: MessageRecord['toolEvents'][number]): MessageBlock[] {
  return [
    ...completeReasoningBlocks(blocks),
    {
      kind: 'tool',
      tool_event: toolEvent,
    },
  ];
}

function getTextFromBlocks(blocks: MessageBlock[]): string {
  return blocks
    .filter((block): block is Extract<MessageBlock, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.text)
    .join('');
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function getThrownMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 96;

function isNearMessageListBottom(messageList: HTMLDivElement) {
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
}

function scrollMessageListToBottom(messageList: HTMLDivElement) {
  messageList.scrollTop = messageList.scrollHeight;
}

const THEME_TOKENS: Record<ResolvedAppearanceMode, Record<string, string>> = {
  light: {
    '--app-bg-color': '#f8f5f1',
    '--bg-main': '#f8f5f1',
    '--bg-sidebar': '#eee8df',
    '--bg-input': '#fffaf4',
    '--bg-input-hover': '#f4eee7',
    '--bg-capsule': '#ece3d9',
    '--surface-bg': '#fffaf4',
    '--surface-bg-strong': '#f2ebe3',
    '--surface-bg-elevated': '#fffdf9',
    '--text-primary': '#2a211d',
    '--text-secondary': '#745d53',
    '--text-muted': 'rgba(42, 33, 29, 0.56)',
    '--text-primary-rgb': '42, 33, 29',
    '--text-secondary-rgb': '116, 93, 83',
    '--border-color': '#d9c8be',
    '--border-subtle': 'rgba(127, 95, 80, 0.18)',
    '--item-hover': 'rgba(184, 105, 78, 0.1)',
    '--item-active': 'rgba(184, 105, 78, 0.16)',
    '--scrollbar-thumb': 'rgba(127, 95, 80, 0.24)',
    '--scrollbar-thumb-hover': 'rgba(127, 95, 80, 0.36)',
    '--shadow-color': 'rgba(96, 61, 45, 0.16)',
    '--assistant-theme': '#b8694e',
    '--assistant-theme-rgb': '184, 105, 78',
    '--theme-surface-is-light': '1',
  },
  dark: {
    '--app-bg-color': '#211c18',
    '--bg-main': '#211c18',
    '--bg-sidebar': '#181410',
    '--bg-input': '#2d261f',
    '--bg-input-hover': '#362d25',
    '--bg-capsule': '#3a3028',
    '--surface-bg': '#2a241f',
    '--surface-bg-strong': '#352d26',
    '--surface-bg-elevated': '#3d332b',
    '--text-primary': '#f8efe7',
    '--text-secondary': '#c8b7aa',
    '--text-muted': 'rgba(248, 239, 231, 0.5)',
    '--text-primary-rgb': '248, 239, 231',
    '--text-secondary-rgb': '200, 183, 170',
    '--border-color': '#4b3d32',
    '--border-subtle': 'rgba(239, 222, 208, 0.12)',
    '--item-hover': 'rgba(239, 222, 208, 0.08)',
    '--item-active': 'rgba(239, 222, 208, 0.13)',
    '--scrollbar-thumb': 'rgba(239, 222, 208, 0.18)',
    '--scrollbar-thumb-hover': 'rgba(239, 222, 208, 0.3)',
    '--shadow-color': 'rgba(8, 5, 3, 0.42)',
    '--assistant-theme': '#d58b6e',
    '--assistant-theme-rgb': '213, 139, 110',
    '--theme-surface-is-light': '0',
  },
};

function applyThemeMode(root: HTMLElement, mode: ResolvedAppearanceMode) {
  root.dataset.themeMode = mode;
  root.dataset.themePreference = mode;
  root.style.setProperty('--ui-font-family', '"Noto Serif SC", Georgia, "Times New Roman", serif');
  root.style.setProperty('--code-font-family', '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Consolas, monospace');
  root.style.setProperty('--ui-font-size', '15px');
  root.style.setProperty('--code-font-size', '14px');
  root.style.setProperty('--app-contrast-filter', 'contrast(100%)');
  Object.entries(THEME_TOKENS[mode]).forEach(([property, value]) => {
    root.style.setProperty(property, value);
  });
}

async function fileToComposerAttachment(file: File): Promise<ComposerAttachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read attachment: ' + file.name));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });

  return {
    id: createAttachmentId(),
    name: file.name,
    mime_type: file.type || 'application/octet-stream',
    kind: file.type.startsWith('image/') ? 'image' : 'file',
    size_bytes: file.size,
    data_url: dataUrl,
    url: dataUrl,
  };
}

export default function App() {
  const [view, setView] = useState<ViewName>('chat');
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('projects');
  const [projectName, setProjectName] = useState('hashcode');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [chatSessions, setChatSessions] = useState<SessionSummary[]>([]);
  const [projectExpansions, setProjectExpansions] = useState<Record<string, boolean>>({});
  const [currentProjectId, setCurrentProjectId] = useState('');
  const [currentProjectSessionId, setCurrentProjectSessionId] = useState('');
  const [currentChatSessionId, setCurrentChatSessionId] = useState('');
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [conversations, setConversations] = useState<Record<string, MessageRecord[]>>({});
  const [contextInputMaps, setContextInputMaps] = useState<Record<string, MessageRecord[]>>({});
  const [contextWorkbenchHistories, setContextWorkbenchHistories] = useState<
    Record<string, ContextWorkbenchHistoryEntry[]>
  >({});
  const [contextRevisionHistories, setContextRevisionHistories] = useState<Record<string, ContextRevisionSummary[]>>({});
  const [pendingContextRestores, setPendingContextRestores] = useState<Record<string, PendingContextRestore>>({});
  const [models, setModels] = useState<string[]>(['gpt-5.4-mini']);
  const [currentModel, setCurrentModel] = useState('gpt-5.4-mini');
  const [reasoningOptions, setReasoningOptions] = useState<ReasoningOption[]>(normalizeReasoningOptions(undefined));
  const [currentReasoning, setCurrentReasoning] = useState('default');
  const [composerValue, setComposerValue] = useState('');
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [runningSessionIds, setRunningSessionIds] = useState<Record<string, boolean>>({});
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<DropdownId>(null);
  const [currentPermission, setCurrentPermission] = useState<PermissionOption>(PERMISSION_OPTIONS[1]);
  const [serviceHintsEnabled, setServiceHintsEnabled] = useState(true);
  const [themeMode, setThemeMode] = useState<AppearanceMode>('light');
  const [userSidebarCollapsed, setUserSidebarCollapsed] = useState(false);
  const [contextMap, setContextMap] = useState<ContextMapState>({
    stage: 0,
    mode: 'condensed',
    width: 320,
  });
  const contextMapVisibleRef = useRef(false);
  const contextMapUnmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevContextMapStageRef = useRef(contextMap.stage);

  // Track visibility with delayed unmount: keep mounted during exit animation then unmount.
  // This prevents the Chromium renderer crash caused by re-showing a CSS-transform-hidden
  // complex layout, while preserving the slide-out animation.
  useEffect(() => {
    const prev = prevContextMapStageRef.current;
    prevContextMapStageRef.current = contextMap.stage;

    if (contextMap.stage !== 0) {
      if (contextMapUnmountTimerRef.current !== null) {
        clearTimeout(contextMapUnmountTimerRef.current);
        contextMapUnmountTimerRef.current = null;
      }
      contextMapVisibleRef.current = true;
    } else if (prev !== 0 && contextMapVisibleRef.current) {
      // Stage just became 0; keep mounted for exit animation, then unmount.
      contextMapUnmountTimerRef.current = setTimeout(() => {
        contextMapVisibleRef.current = false;
        contextMapUnmountTimerRef.current = null;
        // Force a re-render to pick up the new visible state
        setContextMap((p) => ({ ...p }));
      }, 450); // match the 0.4s CSS transition + 50ms buffer
    }
  }, [contextMap.stage]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (contextMapUnmountTimerRef.current !== null) {
        clearTimeout(contextMapUnmountTimerRef.current);
      }
    };
  }, []);

  const isContextMapMounted = contextMapVisibleRef.current || contextMap.stage !== 0;
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [openAISettings, setOpenAISettings] = useState<OpenAISettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>(toSettingsDraft(DEFAULT_SETTINGS));
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [savingProviderId, setSavingProviderId] = useState('');
  const [fetchingProviderId, setFetchingProviderId] = useState('');

  const isSidebarCollapsed = userSidebarCollapsed || contextMap.stage === 2;
  const resolvedThemeMode = themeMode;
  const uiLocale = normalizeSupportedLocale(settingsDraft.user_locale);

  const [toastState, setToastState] = useState({
    message: INITIAL_TOAST_MESSAGE,
    visible: false,
    seq: 0,
  });

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const settingsDraftRef = useRef<SettingsDraft>(settingsDraft);
  const settingsEditableTextOverridesRef = useRef<Partial<Record<EditableTextDraftField, string>>>({});
  const settingsInitializedRef = useRef(false);
  const settingsAutosaveTimerRef = useRef<number | null>(null);
  const settingsAutosaveSnapshotRef = useRef('');
  const settingsAutosaveLatestSnapshotRef = useRef('');
  const currentModelRef = useRef(currentModel);
  const modelSelectionRequestIdRef = useRef(0);
  const currentReasoningRef = useRef(currentReasoning);
  const reasoningSaveRequestIdRef = useRef(0);
  const currentSessionIdRef = useRef(currentSessionId);
  const currentProjectIdRef = useRef(currentProjectId);
  const streamAbortControllersRef = useRef<Record<string, AbortController>>({});
  const stopRequestedSessionIdsRef = useRef<Set<string>>(new Set());
  const stopRequestPromisesRef = useRef<Record<string, Promise<unknown>>>({});
  const shouldStickToMessageBottomRef = useRef(true);
  const previousConversationLengthRef = useRef(0);
  const previousAutoScrollSessionIdRef = useRef('');

  const currentProject = getProjectById(projects, currentProjectId);
  const currentSessionMeta = getSessionMeta(projects, chatSessions, currentSessionId);
  const currentConversation = getConversation(conversations, currentSessionId);
  const currentContextMapMessages = contextInputMaps[currentSessionId] || currentConversation;
  const currentReasoningLabel = getReasoningLabel(currentReasoning, reasoningOptions);
  const hasMessages = currentConversation.length > 0;
  const isSending = Boolean(currentSessionId && runningSessionIds[currentSessionId]);

  const headerTitle = sidebarMode === 'projects'
    ? currentSessionMeta?.session?.title
      ? `${currentProject?.title || '我的项目'} / ${currentSessionMeta.session.title}`
      : currentProject?.title || '我的项目'
    : currentSessionMeta?.session?.title || '我的对话';

  const welcomeText = sidebarMode === 'projects'
    ? `What Should We Work In ${projectName || 'hashcode'}?`
    : '你好，HaShiShark';

  const welcomeAnimationKey = [
    view,
    sidebarMode,
    currentProjectId || 'no-project',
    currentSessionId || 'no-session',
    hasMessages ? 'messages' : 'welcome',
    welcomeText,
  ].join(':');

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    currentModelRef.current = currentModel;
  }, [currentModel]);

  useEffect(() => {
    currentReasoningRef.current = currentReasoning;
  }, [currentReasoning]);

  useEffect(() => localizeAppDom(document.body, uiLocale), [uiLocale]);

  useEffect(() => {
    currentProjectIdRef.current = currentProjectId;
  }, [currentProjectId]);

  const startResizingLeft = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizingLeft(true);
  }, []);

  const startResizingRight = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizingRight(true);
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizingLeft(false);
    setIsResizingRight(false);
  }, []);

  const resize = useCallback((event: MouseEvent) => {
    if (isResizingLeft) {
      const nextWidth = Math.max(200, Math.min(600, event.clientX));
      document.documentElement.style.setProperty('--sidebar-width', `${nextWidth}px`);
    } else if (isResizingRight) {
      const nextWidth = Math.max(240, Math.min(600, window.innerWidth - event.clientX));
      setContextMap((previous) => ({ ...previous, width: nextWidth }));
      document.documentElement.style.setProperty('--context-map-width', `${nextWidth}px`);
    }
  }, [isResizingLeft, isResizingRight]);

  useEffect(() => {
    if (isResizingLeft || isResizingRight) {
      window.addEventListener('mousemove', resize);
      window.addEventListener('mouseup', stopResizing);
    } else {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
    }

    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
    };
  }, [isResizingLeft, isResizingRight, resize, stopResizing]);

  function showToast(message: string) {
    setToastState({
      message,
      visible: true,
      seq: Date.now(),
    });
  }

  function focusComposer() {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

  function applySidebarPayload(
    payload: {
      projects?: ProjectSummary[];
      chat_sessions?: SessionSummary[];
    },
    preferredCurrentProjectId = currentProjectId,
  ) {
    const next = deriveSidebarState(
      payload,
      projects,
      chatSessions,
      projectExpansions,
      preferredCurrentProjectId,
    );

    startTransition(() => {
      setProjects(next.projects);
      setChatSessions(next.chatSessions);
      setProjectExpansions(next.projectExpansions);
      setCurrentProjectId(next.currentProjectId);
    });

    return next;
  }

  function firstProjectSessionId(projectId: string, projectList: ProjectSummary[]) {
    return projectList.find((project) => project.id === projectId)?.sessions[0]?.id || '';
  }

  function firstChatSessionId(sessionList: SessionSummary[]) {
    return sessionList[0]?.id || '';
  }

  function updatePendingAssistantMessage(
    sessionId: string,
    updater: (message: MessageRecord) => MessageRecord,
  ) {
    setConversations((previous) => {
      const history = [...(previous[sessionId] || [])];
      if (!history.length) {
        return previous;
      }

      const lastMessage = history[history.length - 1];
      history[history.length - 1] = updater(lastMessage);

      return {
        ...previous,
        [sessionId]: history,
      };
    });
  }

  function updateContextInputMap(sessionId: string, records?: MessageRecord[] | null) {
    if (!sessionId || !records) {
      return;
    }

    setContextInputMaps((previous) => ({
      ...previous,
      [sessionId]: records,
    }));
  }

  function updateContextInputMapFromTranscript(sessionId: string, records?: Parameters<typeof normalizeConversation>[0]) {
    if (!sessionId || !records) {
      return;
    }

    updateContextInputMap(sessionId, normalizeConversation(records));
  }

  function finalizePendingAssistantMessage(
    sessionId: string,
    sourceText: string,
    fallbackText = '已停止本次回复。',
  ) {
    updatePendingAssistantMessage(sessionId, (lastMessage) => {
      const settledBlocks = completeReasoningBlocks(lastMessage.blocks);
      const nextBlocks = settledBlocks.length
        ? settledBlocks
        : (lastMessage.text.trim() ? [createTextBlock(lastMessage.text)] : [createTextBlock(fallbackText)]);
      const nextText = getTextFromBlocks(nextBlocks) || lastMessage.text.trim() || fallbackText;

      return {
        ...lastMessage,
        role: 'assistant',
        text: nextText,
        blocks: nextBlocks,
        pending: false,
        sourceText,
      };
    });
  }

  function markSessionRunning(sessionId: string, controller: AbortController) {
    streamAbortControllersRef.current[sessionId] = controller;
    setRunningSessionIds((previous) => ({
      ...previous,
      [sessionId]: true,
    }));
  }

  function clearSessionRunning(sessionId: string, controller?: AbortController) {
    if (!sessionId) {
      return;
    }

    if (!controller || streamAbortControllersRef.current[sessionId] === controller) {
      delete streamAbortControllersRef.current[sessionId];
    }
    stopRequestedSessionIdsRef.current.delete(sessionId);
    delete stopRequestPromisesRef.current[sessionId];
    setRunningSessionIds((previous) => {
      if (!previous[sessionId]) {
        return previous;
      }

      const next = { ...previous };
      delete next[sessionId];
      return next;
    });
  }

  function abortSessionRequest(sessionId: string) {
    const controller = streamAbortControllersRef.current[sessionId];
    if (!controller) {
      return false;
    }

    stopRequestedSessionIdsRef.current.add(sessionId);
    stopRequestPromisesRef.current[sessionId] = cancelActiveRequest({
      session_id: sessionId,
      mode: 'main',
    }).catch(() => undefined);
    controller.abort();
    return true;
  }

  function abortSessionRequests(sessionIds: Iterable<string>) {
    let aborted = false;
    Array.from(sessionIds).forEach((sessionId) => {
      aborted = abortSessionRequest(sessionId) || aborted;
    });
    return aborted;
  }

  function isViewingSession(sessionId: string) {
    return currentSessionIdRef.current === sessionId;
  }

  function currentUiPreferences(): PersistedUiPreferences {
    return {
      theme_mode: themeMode,
      service_hints_enabled: serviceHintsEnabled,
    };
  }

  function syncSavedSettingsMetadata(
    nextSettings: OpenAISettings,
    nextModels?: string[],
    options: {
      preserveCurrentModel?: boolean;
      preserveCurrentReasoning?: boolean;
    } = {},
  ) {
    const preserveCurrentModel = options.preserveCurrentModel ?? false;
    const preserveCurrentReasoning = options.preserveCurrentReasoning ?? false;
    const normalizedSettings = normalizeSettingsPayload(nextSettings);
    const availableModels = Array.isArray(nextModels) && nextModels.length
      ? nextModels
      : model_options_fallback(normalizedSettings.default_model);

    setOpenAISettings(normalizedSettings);
    setModels((previous) => {
      const merged = [currentModelRef.current, ...availableModels, ...previous].filter(Boolean);
      return Array.from(new Set(merged));
    });
    const nextCurrentModel = preserveCurrentModel && currentModelRef.current
      ? currentModelRef.current
      : normalizedSettings.default_model || availableModels[0] || 'gpt-5.4-mini';
    currentModelRef.current = nextCurrentModel;
    setCurrentModel(nextCurrentModel);
    setCurrentReasoning((previous) => {
      const nextReasoning = preserveCurrentReasoning
        ? currentReasoningRef.current || previous
        : resolveReasoningEffort(normalizedSettings.default_reasoning_effort || previous, reasoningOptions);
      currentReasoningRef.current = nextReasoning;
      return nextReasoning;
    });
  }

  function syncSettingsState(
    nextSettings: OpenAISettings,
    nextModels?: string[],
    options: {
      preserveCurrentModel?: boolean;
      preserveCurrentReasoning?: boolean;
    } = {},
  ) {
    const preserveCurrentModel = options.preserveCurrentModel ?? false;
    const preserveCurrentReasoning = options.preserveCurrentReasoning ?? false;
    const normalizedSettings = normalizeSettingsPayload(nextSettings);
    const availableModels = Array.isArray(nextModels) && nextModels.length
      ? nextModels
      : model_options_fallback(normalizedSettings.default_model);
    let nextDraft = toSettingsDraft(normalizedSettings);
    if (preserveCurrentModel && currentModelRef.current.trim()) {
      const currentModelId = currentModelRef.current.trim();
      const previousActiveProviderId = settingsDraftRef.current.active_provider_id;
      const providerForCurrentModel =
        nextDraft.response_providers.find(
          (provider) =>
            provider.id === previousActiveProviderId &&
            provider.models.some((model) => (model.id || model.label || '').trim() === currentModelId),
        ) ||
        nextDraft.response_providers.find((provider) =>
          provider.models.some((model) => (model.id || model.label || '').trim() === currentModelId),
        ) ||
        nextDraft.response_providers.find((provider) => provider.id === previousActiveProviderId);

      nextDraft = providerForCurrentModel
        ? applyProviderModelSelection(nextDraft, providerForCurrentModel.id, currentModelId)
        : {
            ...nextDraft,
            default_model: currentModelId,
          };
    }
    nextDraft = applyEditableTextOverrides(
      preserveEditableDraftFields(nextDraft, settingsDraftRef.current),
      settingsEditableTextOverridesRef.current,
    );
    const nextPreferences = uiPreferencesFromSettings(normalizedSettings);

    setOpenAISettings(normalizedSettings);
    settingsDraftRef.current = nextDraft;
    const nextSnapshot = settingsPayloadSnapshot(
      buildSettingsSavePayload(nextDraft, {
        defaultReasoningEffort: normalizedSettings.default_reasoning_effort,
        uiPreferences: nextPreferences,
      }),
    );
    settingsAutosaveSnapshotRef.current = nextSnapshot;
    settingsAutosaveLatestSnapshotRef.current = nextSnapshot;
    settingsInitializedRef.current = true;
    setSettingsDraft(nextDraft);
    setServiceHintsEnabled(nextPreferences.service_hints_enabled);
    setThemeMode(nextPreferences.theme_mode);
    setModels((previous) => {
      const merged = [currentModelRef.current, ...availableModels, ...previous].filter(Boolean);
      return Array.from(new Set(merged));
    });
    const nextCurrentModel = preserveCurrentModel && currentModelRef.current
      ? currentModelRef.current
      : normalizedSettings.default_model || availableModels[0] || 'gpt-5.4-mini';
    currentModelRef.current = nextCurrentModel;
    setCurrentModel(nextCurrentModel);
    setCurrentReasoning((previous) => {
      const nextReasoning = preserveCurrentReasoning
        ? currentReasoningRef.current || previous
        : resolveReasoningEffort(normalizedSettings.default_reasoning_effort || previous, reasoningOptions);
      currentReasoningRef.current = nextReasoning;
      return nextReasoning;
    });
  }

  function updateSettingsDraftState(updater: (previous: SettingsDraft) => SettingsDraft) {
    const next = updater(settingsDraftRef.current);
    settingsDraftRef.current = next;
    setSettingsDraft(next);
  }

  function rememberEditableTextPatch(patch: Partial<SettingsDraft>) {
    const editablePatch = patch as Partial<Record<EditableTextDraftField, string>>;
    const nextOverrides = { ...settingsEditableTextOverridesRef.current };

    editableTextDraftFields.forEach((field) => {
      if (editablePatch[field] !== undefined) {
        nextOverrides[field] = editablePatch[field];
      }
    });

    settingsEditableTextOverridesRef.current = nextOverrides;
  }

  function updateProviderDraftState(providerId: string, patch: Partial<ResponseProviderDraft>) {
    updateSettingsDraftState((previous) => {
      const nextProviders = previous.response_providers.map((provider) => {
        if (provider.id !== providerId) {
          return provider;
        }

        return {
          ...provider,
          ...patch,
          clear_api_key: patch.clear_api_key ?? (patch.api_key_input !== undefined ? false : provider.clear_api_key),
        };
      });

      const activeProvider = nextProviders.find((provider) => provider.id === previous.active_provider_id);
      return {
        ...previous,
        response_providers: nextProviders,
        default_model: activeProvider?.default_model || previous.default_model,
        openai_base_url: activeProvider?.api_base_url || previous.openai_base_url,
        openai_api_key:
          providerId === previous.active_provider_id && patch.api_key_input !== undefined
            ? patch.api_key_input
            : previous.openai_api_key,
      };
    });
  }

  function addProviderDraftState(providerType: ProviderType, providerName?: string) {
    const provider = createProviderDraft(providerType, settingsDraftRef.current.response_providers, providerName);
    updateSettingsDraftState((previous) => ({
      ...previous,
      response_providers: [...previous.response_providers, provider],
    }));
    return provider.id;
  }

  async function deleteProviderDraftState(providerId: string): Promise<string> {
    const previousDraft = settingsDraftRef.current;
    const nextDraft = removeProviderFromDraft(previousDraft, providerId);
    const nextSelectedProviderId = nextDraft.active_provider_id || nextDraft.response_providers[0]?.id || 'openai';

    settingsDraftRef.current = nextDraft;
    setSettingsDraft(nextDraft);
    setSavingProviderId(providerId);
    try {
      const response = await saveSettingsRequest({
        ...buildSettingsSavePayload(nextDraft, {
          defaultReasoningEffort: currentReasoningRef.current,
          uiPreferences: currentUiPreferences(),
        }),
        deleted_provider_ids: [providerId],
      });
      syncSettingsState(response.settings, response.models);
      showToast(SETTINGS_SAVED_TOAST);
      return nextSelectedProviderId;
    } catch (error) {
      settingsDraftRef.current = previousDraft;
      setSettingsDraft(previousDraft);
      showToast(getThrownMessage(error));
      return previousDraft.active_provider_id || previousDraft.response_providers[0]?.id || 'openai';
    } finally {
      setSavingProviderId('');
    }
  }

  function applySettingsDraftPatch(patch: Partial<SettingsDraft>) {
    rememberEditableTextPatch(patch);
    updateSettingsDraftState((previous) => {
      const next = {
        ...previous,
        ...patch,
        user_locale: patch.user_locale !== undefined
          ? normalizeSupportedLocale(patch.user_locale)
          : previous.user_locale,
      };

      const activeProviderIndex = next.response_providers.findIndex((provider) => provider.id === next.active_provider_id);
      if (activeProviderIndex === -1) {
        return next;
      }

      const activeProvider = next.response_providers[activeProviderIndex];
      const nextActiveProvider: ResponseProviderDraft = {
        ...activeProvider,
        default_model: patch.default_model !== undefined ? patch.default_model : activeProvider.default_model,
        api_base_url: patch.openai_base_url !== undefined ? patch.openai_base_url : activeProvider.api_base_url,
        api_key_input: patch.openai_api_key !== undefined ? patch.openai_api_key : activeProvider.api_key_input,
        clear_api_key: patch.openai_api_key !== undefined ? false : activeProvider.clear_api_key,
      };

      const nextProviders = [...next.response_providers];
      nextProviders[activeProviderIndex] = nextActiveProvider;

      return {
        ...next,
        response_providers: nextProviders,
      };
    });
  }

  async function persistProviderSettings(
    providerId: string,
    options: {
      activate?: boolean;
      clearApiKey?: boolean;
      silent?: boolean;
    } = {},
  ) {
    setSavingProviderId(providerId);
    try {
      const response = await saveSettingsRequest(
        buildSettingsSavePayload(settingsDraftRef.current, {
          activeProviderId: options.activate ? providerId : undefined,
          clearProviderApiKeyId: options.clearApiKey ? providerId : undefined,
          defaultReasoningEffort: currentReasoningRef.current,
          uiPreferences: currentUiPreferences(),
        }),
      );
      syncSettingsState(response.settings, response.models);
      if (!options.silent) {
        showToast(SETTINGS_SAVED_TOAST);
      }
    } catch (error) {
      showToast(getThrownMessage(error));
    } finally {
      setSavingProviderId('');
    }
  }

  async function loadProviderModelCandidates(providerId: string): Promise<ResponseProviderModel[]> {
    const provider = settingsDraftRef.current.response_providers.find((item) => item.id === providerId);
    if (!provider) {
      return [];
    }

    setFetchingProviderId(providerId);
    try {
      const response = await fetchProviderModelCandidatesRequest({
        provider_id: providerId,
        api_base_url: provider.api_base_url.trim(),
        provider_type: provider.provider_type,
        ...(provider.api_key_input.trim()
          ? { api_key: provider.api_key_input.trim() }
          : {}),
      });
      return response.models;
    } catch (error) {
      throw error;
    } finally {
      setFetchingProviderId('');
    }
  }

  useEffect(() => {
    async function initializeApp() {
      try {
        const [initData, settingsData] = await Promise.all([fetchInit(), fetchSettings()]);
        const nextReasoningOptions = normalizeReasoningOptions(initData.reasoning_options);
        const nextModels = Array.from(
          new Set(
            [
              ...(Array.isArray(settingsData.models) ? settingsData.models : []),
              ...(Array.isArray(initData.models) ? initData.models : []),
            ].filter(Boolean),
          ),
        );
        const nextModel = initData.default_model || settingsData.settings.default_model || nextModels[0] || 'gpt-5.4-mini';
        const preferredReasoning = nextReasoningOptions.find((option) => option.value === 'default')
          ? 'default'
          : nextReasoningOptions[0]?.value || 'default';
        const nextConversations = buildConversationMap(initData.conversations);
        const nextContextInputMaps = buildConversationMap(initData.context_inputs);
        const nextWorkbenchHistories = buildContextWorkbenchHistoryMap(initData.context_workbench_histories);
        const nextRevisionHistories = buildContextRevisionHistoryMap(initData.context_revision_histories);
        const nextPendingRestores = buildPendingContextRestoreMap(initData.pending_context_restores);
        const nextSidebarState = deriveSidebarState(initData, initData.projects || [], initData.chat_sessions || [], {}, '');
        const nextSettings = normalizeSettingsPayload(
          (settingsData.settings || initData.settings || DEFAULT_SETTINGS) as Partial<OpenAISettings>,
        );
        const nextSettingsDraft = toSettingsDraft(nextSettings);
        const nextPreferences = uiPreferencesFromSettings(nextSettings);
        const nextCurrentReasoning = resolveReasoningEffort(
          nextSettings.default_reasoning_effort || preferredReasoning,
          nextReasoningOptions,
        );
        const nextSnapshot = settingsPayloadSnapshot(
          buildSettingsSavePayload(nextSettingsDraft, {
            defaultReasoningEffort: nextSettings.default_reasoning_effort,
            uiPreferences: nextPreferences,
          }),
        );
        settingsAutosaveSnapshotRef.current = nextSnapshot;
        settingsAutosaveLatestSnapshotRef.current = nextSnapshot;
        currentModelRef.current = nextModel;
        currentReasoningRef.current = nextCurrentReasoning;

        startTransition(() => {
          setProjectName(initData.project_name || 'hashcode');
          setModels(nextModels.length ? nextModels : [nextModel]);
          setCurrentModel(nextModel);
          setReasoningOptions(nextReasoningOptions);
          setCurrentReasoning(nextCurrentReasoning);
          setConversations(nextConversations);
          setContextInputMaps(nextContextInputMaps);
          setContextWorkbenchHistories(nextWorkbenchHistories);
          setContextRevisionHistories(nextRevisionHistories);
          setPendingContextRestores(nextPendingRestores);
          setProjects(nextSidebarState.projects);
          setChatSessions(nextSidebarState.chatSessions);
          setProjectExpansions(nextSidebarState.projectExpansions);
          setCurrentProjectId(nextSidebarState.currentProjectId);
          setCurrentSessionId('');
          setCurrentProjectSessionId('');
          setCurrentChatSessionId('');
          setOpenAISettings(nextSettings);
          settingsDraftRef.current = nextSettingsDraft;
          setSettingsDraft(nextSettingsDraft);
          setServiceHintsEnabled(nextPreferences.service_hints_enabled);
          setThemeMode(nextPreferences.theme_mode);
          settingsInitializedRef.current = true;
        });
      } catch (error) {
        showToast(getThrownMessage(error));
      }
    }

    void initializeApp();
  }, []);

  useEffect(() => {
    settingsDraftRef.current = settingsDraft;
  }, [settingsDraft]);

  useEffect(() => {
    if (!settingsInitializedRef.current) {
      return;
    }

    const payload = buildSettingsSavePayload(settingsDraft, {
      defaultReasoningEffort: currentReasoningRef.current,
      uiPreferences: currentUiPreferences(),
    });
    const snapshot = settingsPayloadSnapshot(payload);
    settingsAutosaveLatestSnapshotRef.current = snapshot;
    if (snapshot === settingsAutosaveSnapshotRef.current) {
      return;
    }

    if (settingsAutosaveTimerRef.current) {
      window.clearTimeout(settingsAutosaveTimerRef.current);
    }

    settingsAutosaveTimerRef.current = window.setTimeout(async () => {
      try {
        const response = await saveSettingsRequest(payload);
        if (settingsAutosaveLatestSnapshotRef.current !== snapshot) {
          return;
        }
        settingsAutosaveSnapshotRef.current = snapshot;
        settingsAutosaveLatestSnapshotRef.current = snapshot;
        syncSavedSettingsMetadata(response.settings, response.models);
      } catch (error) {
        showToast(getThrownMessage(error));
      }
    }, 800);

    return () => {
      if (settingsAutosaveTimerRef.current) {
        window.clearTimeout(settingsAutosaveTimerRef.current);
      }
    };
  }, [serviceHintsEnabled, settingsDraft, themeMode]);

  useEffect(() => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }

    if (!toastState.visible) {
      return;
    }

    toastTimerRef.current = window.setTimeout(() => {
      setToastState((previous) => ({ ...previous, visible: false }));
    }, 3000);

    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, [toastState.seq, toastState.visible]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    applyThemeMode(root, resolvedThemeMode);
  }, [resolvedThemeMode]);

  useEffect(() => {
    document.body.classList.toggle('sidebar-collapsed', isSidebarCollapsed);

    return () => {
      document.body.classList.remove('sidebar-collapsed');
    };
  }, [isSidebarCollapsed]);

  useEffect(() => {
    function handleDocumentClick() {
      setOpenDropdown(null);
    }

    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, []);

  useEffect(() => {
    if (view !== 'chat') {
      setIsModelPickerOpen(false);
    }
  }, [view]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [composerValue, view]);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (!messageList || view !== 'chat') {
      return;
    }

    const scrollContainer = messageList;

    function syncShouldStickToBottom() {
      shouldStickToMessageBottomRef.current = isNearMessageListBottom(scrollContainer);
    }

    syncShouldStickToBottom();
    scrollContainer.addEventListener('scroll', syncShouldStickToBottom, { passive: true });

    return () => {
      scrollContainer.removeEventListener('scroll', syncShouldStickToBottom);
    };
  }, [currentSessionId, hasMessages, view]);

  useLayoutEffect(() => {
    const messageList = messageListRef.current;
    const sessionChanged = previousAutoScrollSessionIdRef.current !== currentSessionId;
    const previousConversationLength = sessionChanged ? 0 : previousConversationLengthRef.current;
    const messageAdded = currentConversation.length > previousConversationLength;

    previousAutoScrollSessionIdRef.current = currentSessionId;
    previousConversationLengthRef.current = currentConversation.length;

    if (!hasMessages || view !== 'chat' || !messageList) {
      shouldStickToMessageBottomRef.current = true;
      return;
    }

    if (sessionChanged || messageAdded || shouldStickToMessageBottomRef.current) {
      scrollMessageListToBottom(messageList);
      shouldStickToMessageBottomRef.current = true;
    }
  }, [currentConversation, currentSessionId, hasMessages, view]);

  async function createProject(
    silent = false,
    options: {
      title?: string;
      rootPath?: string;
    } = {},
  ) {
    const data = await createProjectRequest({
      title: options.title,
      root_path: options.rootPath,
    });
    applySidebarPayload(data, data.project.id);
    setCurrentProjectId(data.project.id);
    setCurrentSessionId('');
    setCurrentProjectSessionId('');
    setView('chat');
    focusComposer();

    if (!silent) {
      showToast(NEW_PROJECT_TOAST);
    }

    return data.project.id;
  }

  async function handleAddSidebarItem() {
    if (sidebarMode !== 'projects') {
      await createSession(false, { scope: 'chat' });
      return;
    }

    if (!window.electronAPI?.selectFolder) {
      showToast('需要在桌面端选择本地文件夹。');
      return;
    }

    const folder = await window.electronAPI.selectFolder();
    if (!folder || folder.canceled) {
      return;
    }

    if (!folder.path) {
      showToast('没有拿到文件夹路径。');
      return;
    }

    await createProject(false, {
      title: folder.name || folder.path.split(/[\\/]/).filter(Boolean).pop() || '新项目',
      rootPath: folder.path,
    });
  }

  async function createSession(
    silent = false,
    options: {
      scope?: 'chat' | 'project';
      projectId?: string | null;
    } = {},
  ) {
    const scope = options.scope || (sidebarMode === 'projects' ? 'project' : 'chat');
    let projectId = options.projectId || null;

    if (scope === 'project' && !projectId) {
      projectId = currentProjectId || projects[0]?.id || null;
      if (!projectId) {
        projectId = await createProject(true);
      }
    }

    const data = await createSessionRequest({
      scope,
      project_id: projectId,
    });

    applySidebarPayload(data, data.session.project_id || projectId || currentProjectId);
    setConversations((previous) => ({
      ...previous,
      [data.session.id]: previous[data.session.id] || [],
    }));
    updateContextInputMapFromTranscript(data.session.id, data.context_input);
    setContextWorkbenchHistories((previous) => ({
      ...previous,
      [data.session.id]: previous[data.session.id] || [],
    }));
    setContextRevisionHistories((previous) => ({
      ...previous,
      [data.session.id]: previous[data.session.id] || [],
    }));
    setPendingContextRestores((previous) => {
      const next = { ...previous };
      delete next[data.session.id];
      return next;
    });

    if (data.session.scope === 'project') {
      const nextProjectId = data.session.project_id || projectId || currentProjectId;
      setCurrentProjectId(nextProjectId || '');
      currentProjectIdRef.current = nextProjectId || '';
      setCurrentProjectSessionId(data.session.id);
      if (nextProjectId) {
        setProjectExpansions((previous) => ({
          ...previous,
          [nextProjectId]: true,
        }));
      }
    } else {
      setCurrentChatSessionId(data.session.id);
    }

    setCurrentSessionId(data.session.id);
    currentSessionIdRef.current = data.session.id;
    setView('chat');
    focusComposer();

    if (!silent) {
      showToast(NEW_CHAT_TOAST);
    }

    return data.session.id;
  }

  async function ensureSession() {
    if (currentSessionId) {
      return currentSessionId;
    }

    if (sidebarMode === 'projects') {
      if (!currentProjectId && !projects.length) {
        await createProject(true);
      }

      return createSession(true, {
        scope: 'project',
        projectId: currentProjectId || projects[0]?.id || null,
      });
    }

    return createSession(true, { scope: 'chat' });
  }

  async function handleDeleteSession(sessionId: string) {
    const meta = getSessionMeta(projects, chatSessions, sessionId);
    if (!meta) {
      showToast('没有找到这条对话。');
      return;
    }

    try {
      const data = await deleteSessionRequest(sessionId);
      const nextSidebar = applySidebarPayload(data, meta.projectId || currentProjectId);
      setConversations((previous) => {
        const next = { ...previous };
        delete next[sessionId];
        return next;
      });
      setContextWorkbenchHistories((previous) => {
        const next = { ...previous };
        delete next[sessionId];
        return next;
      });
      setContextRevisionHistories((previous) => {
        const next = { ...previous };
        delete next[sessionId];
        return next;
      });
      setPendingContextRestores((previous) => {
        const next = { ...previous };
        delete next[sessionId];
        return next;
      });

      if (meta.scope === 'project') {
        if (currentProjectSessionId === sessionId) {
          const fallbackSessionId = firstProjectSessionId(meta.projectId || currentProjectId, nextSidebar.projects);
          setCurrentProjectSessionId(fallbackSessionId);
          if (currentSessionId === sessionId) {
            setCurrentSessionId(fallbackSessionId);
          }
        }
      } else if (currentChatSessionId === sessionId) {
        const fallbackSessionId = firstChatSessionId(nextSidebar.chatSessions);
        setCurrentChatSessionId(fallbackSessionId);
        if (currentSessionId === sessionId) {
          setCurrentSessionId(fallbackSessionId);
        }
      }

      if (currentSessionId === sessionId) {
        abortSessionRequest(sessionId);
        focusComposer();
      }

      showToast(DELETE_CHAT_TOAST);
    } catch (error) {
      showToast(getThrownMessage(error));
    }
  }

  async function handleDeleteProject(project: ProjectSummary) {
    const confirmed = window.confirm(
      localizeUiText('Delete project ' + project.title + ' and its sessions?', uiLocale),
    );
    if (!confirmed) {
      return;
    }

    const projectSessionIds = new Set((project.sessions || []).map((session) => session.id));

    setView('chat');
    window.focus();
    focusComposer();

    abortSessionRequests(projectSessionIds);

    try {
      const data = await deleteProjectRequest(project.id);
      const deletedSessionIds = new Set(data.deleted_session_ids);
      const next = applySidebarPayload(data, data.projects?.[0]?.id || '');
      const deletedCurrentSession = deletedSessionIds.has(currentSessionId);
      const deletedProjectSession = deletedSessionIds.has(currentProjectSessionId);

      setProjectExpansions((previous) => {
        const updated = { ...previous };
        delete updated[project.id];
        return updated;
      });
      setConversations((previous) => {
        const updated = { ...previous };
        deletedSessionIds.forEach((sessionId) => {
          delete updated[sessionId];
        });
        return updated;
      });
      setContextWorkbenchHistories((previous) => {
        const updated = { ...previous };
        deletedSessionIds.forEach((sessionId) => {
          delete updated[sessionId];
        });
        return updated;
      });
      setContextRevisionHistories((previous) => {
        const updated = { ...previous };
        deletedSessionIds.forEach((sessionId) => {
          delete updated[sessionId];
        });
        return updated;
      });
      setPendingContextRestores((previous) => {
        const updated = { ...previous };
        deletedSessionIds.forEach((sessionId) => {
          delete updated[sessionId];
        });
        return updated;
      });

      if (currentProjectId === project.id) {
        setCurrentProjectId(next.currentProjectId);
      }
      if (deletedProjectSession || currentProjectId === project.id) {
        const fallbackSessionId = firstProjectSessionId(next.currentProjectId, next.projects);
        setCurrentProjectSessionId(fallbackSessionId);
        if (deletedCurrentSession || currentProjectId === project.id) {
          setCurrentSessionId(fallbackSessionId);
        }
      }
      abortSessionRequests(deletedSessionIds);

      setView('chat');
      window.focus();
      focusComposer();
      showToast('Project deleted.');
    } catch (error) {
      showToast(getThrownMessage(error));
    }
  }

  async function handlePinProject(project: ProjectSummary) {
    try {
      const data = await pinProjectRequest(project.id);
      applySidebarPayload(data, project.id);
      setCurrentProjectId(project.id);
      showToast('Project pinned.');
    } catch (error) {
      showToast(getThrownMessage(error));
    }
  }

  async function handleRenameProject(project: ProjectSummary) {
    const nextTitle = window.prompt(localizeUiText('Rename project', uiLocale), project.title)?.trim();
    if (!nextTitle || nextTitle === project.title) {
      return;
    }

    try {
      const data = await renameProjectRequest(project.id, nextTitle);
      applySidebarPayload(data, project.id);
      setCurrentProjectId(project.id);
      showToast('Project renamed.');
    } catch (error) {
      showToast(getThrownMessage(error));
    }
  }

  async function handleOpenProjectParent(project: ProjectSummary) {
    const rootPath = project.root_path || '';
    if (!rootPath) {
      showToast('This project has no local folder.');
      return;
    }

    if (!window.electronAPI?.openProjectParentFolder) {
      showToast('Open this from the desktop app.');
      return;
    }

    const result = await window.electronAPI.openProjectParentFolder(rootPath);
    if (result.ok) {
      showToast('Opened project folder.');
      return;
    }
    showToast(String(result.error));
  }

  async function handleArchiveProjectSessions(project: ProjectSummary) {
    const sessionCount = project.sessions.length;
    if (!sessionCount) {
      showToast('这个项目还没有可归档的对话。');
      return;
    }

    const confirmed = window.confirm(localizeUiText('Archive ' + sessionCount + ' sessions in ' + project.title + '?', uiLocale));
    if (!confirmed) {
      return;
    }

    try {
      const data = await archiveProjectSessionsRequest(project.id);
      const archivedSessionIds = new Set(data.archived_session_ids);
      const next = applySidebarPayload(data, project.id);
      const archivedCurrentSession = archivedSessionIds.has(currentSessionId);
      const archivedProjectSession = archivedSessionIds.has(currentProjectSessionId);

      if (archivedProjectSession || currentProjectId === project.id) {
        const fallbackSessionId = firstProjectSessionId(project.id, next.projects);
        setCurrentProjectSessionId(fallbackSessionId);
        if (archivedCurrentSession || currentProjectId === project.id) {
          setCurrentSessionId(fallbackSessionId);
        }
      }
      abortSessionRequests(archivedSessionIds);

      showToast('Project sessions archived.');
    } catch (error) {
      showToast(getThrownMessage(error));
    }
  }

  function handleSwitchSession(sessionId: string) {
    const meta = getSessionMeta(projects, chatSessions, sessionId);
    if (!meta) {
      showToast('Session not found.');
      return;
    }

    setCurrentSessionId(sessionId);
    currentSessionIdRef.current = sessionId;
    setView('chat');

    if (meta.scope === 'project') {
      const projectId = meta.projectId || '';
      setCurrentProjectId(projectId);
      currentProjectIdRef.current = projectId;
      setCurrentProjectSessionId(sessionId);
      if (projectId) {
        setProjectExpansions((previous) => ({
          ...previous,
          [projectId]: true,
        }));
      }
    } else {
      setCurrentChatSessionId(sessionId);
    }

    focusComposer();
  }

  function handleProjectSelect(projectId: string) {
    setCurrentProjectId(projectId);
    setCurrentSessionId('');
    currentProjectIdRef.current = projectId;
    currentSessionIdRef.current = '';
    setProjectExpansions((previous) => ({
      ...previous,
      [projectId]: !previous[projectId],
    }));
  }

  async function handleComposerAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const fileList = Array.from(event.target.files || []);
    event.target.value = '';

    if (!fileList.length) {
      return;
    }

    try {
      const nextAttachments = await Promise.all(fileList.map(fileToComposerAttachment));
      setComposerAttachments((previous) => [...previous, ...nextAttachments]);
      showToast(ATTACHMENT_READY_TOAST);
      focusComposer();
    } catch (error) {
      showToast(getThrownMessage(error));
    }
  }

  function handleRemoveAttachment(attachmentId: string) {
    setComposerAttachments((previous) => previous.filter((item) => item.id !== attachmentId));
    showToast(ATTACHMENT_REMOVED_TOAST);
  }

  async function handleSend() {
    const message = composerValue.trim();
    const attachments = composerAttachments;

    if (!message && !attachments.length) {
      showToast(EMPTY_SEND_TOAST);
      return;
    }

    if (currentSessionId && runningSessionIds[currentSessionId]) {
      showToast(SENDING_TOAST);
      return;
    }

    let sessionId = currentSessionId;
    let streamController: AbortController | null = null;
    try {
      sessionId = await ensureSession();
      if (streamAbortControllersRef.current[sessionId]) {
        showToast(SENDING_TOAST);
        return;
      }

      streamController = new AbortController();
      markSessionRunning(sessionId, streamController);
      const userMessage: MessageRecord = {
        role: 'user',
        text: message,
        attachments: toMessageAttachments(attachments),
        toolEvents: [],
        blocks: message ? [createTextBlock(message)] : [],
        pending: false,
        sourceText: '',
      };
      const pendingMessage: MessageRecord = {
        role: 'assistant',
        text: '',
        attachments: [],
        toolEvents: [],
        blocks: [],
        pending: true,
        sourceText: message,
      };

      setConversations((previous) => {
        const history = previous[sessionId] || [];
        return {
          ...previous,
          [sessionId]: [...history, userMessage, pendingMessage],
        };
      });

      setComposerValue('');
      setComposerAttachments([]);
      setView('chat');
      setCurrentSessionId(sessionId);
      currentSessionIdRef.current = sessionId;

      let streamError = '';
      let streamCompleted = false;

      const sendPayload = {
        session_id: sessionId,
        message,
        model: currentModel,
        reasoning_effort: currentReasoning,
        attachments,
      };

      if (!settingsDraftRef.current.streaming) {
        const response = await sendMessageRequest(sendPayload);
        streamCompleted = true;
        updatePendingAssistantMessage(sessionId, (lastMessage) => {
          const nextBlocks = response.blocks || lastMessage.blocks;
          const nextText = getTextFromBlocks(nextBlocks) || response.answer || lastMessage.text;

          return {
            role: 'assistant',
            text: nextText,
            attachments: [],
            toolEvents: response.tool_events || lastMessage.toolEvents,
            blocks: nextBlocks,
            pending: false,
            sourceText: message,
          };
        });
        applySidebarPayload(
          response,
          isViewingSession(sessionId)
            ? response.session.project_id || currentProjectIdRef.current
            : currentProjectIdRef.current,
        );
        updateContextInputMapFromTranscript(sessionId, response.context_input);
        if (isViewingSession(sessionId) && response.session.scope === 'project') {
          const nextProjectId = response.session.project_id || currentProjectIdRef.current;
          setCurrentProjectId(nextProjectId || '');
          setCurrentProjectSessionId(response.session.id);
          if (nextProjectId) {
            setProjectExpansions((previous) => ({
              ...previous,
              [nextProjectId]: true,
            }));
          }
        } else if (isViewingSession(sessionId)) {
          setCurrentChatSessionId(response.session.id);
        }
        setPendingContextRestores((previous) => {
          const next = { ...previous };
          delete next[sessionId];
          return next;
        });
        if (Array.isArray(response.tool_events) && response.tool_events.length) {
          showToast('Tool calls: ' + response.tool_events.length + '.');
        }
        return;
      }

      await streamMessageRequest(
        sendPayload,
        (event) => {
          if (event.type === 'delta') {
            const isReasoningDelta = event.kind === 'reasoning';
            updatePendingAssistantMessage(sessionId, (lastMessage) => ({
              ...lastMessage,
              role: 'assistant',
              text: isReasoningDelta ? lastMessage.text : lastMessage.text + event.delta,
              blocks: isReasoningDelta
                ? appendReasoningDeltaToBlocks(lastMessage.blocks, event.delta)
                : appendDeltaToBlocks(lastMessage.blocks, event.delta),
              pending: true,
            }));
            return;
          }

          if (event.type === 'model_start') {
            updatePendingAssistantMessage(sessionId, (lastMessage) => ({
              ...lastMessage,
              role: 'assistant',
              blocks: startThinkingBlock(lastMessage.blocks),
              pending: true,
            }));
            return;
          }

          if (event.type === 'model_done') {
            updatePendingAssistantMessage(sessionId, (lastMessage) => ({
              ...lastMessage,
              role: 'assistant',
              blocks: completeReasoningBlocks(lastMessage.blocks),
              pending: true,
            }));
            return;
          }

          if (event.type === 'reasoning_start') {
            updatePendingAssistantMessage(sessionId, (lastMessage) => ({
              ...lastMessage,
              role: 'assistant',
              blocks: startReasoningBlock(lastMessage.blocks),
              pending: true,
            }));
            return;
          }

          if (event.type === 'reasoning_done') {
            updatePendingAssistantMessage(sessionId, (lastMessage) => ({
              ...lastMessage,
              role: 'assistant',
              blocks: completeReasoningBlocks(lastMessage.blocks),
              pending: true,
            }));
            return;
          }

          if (event.type === 'reset') {
            updatePendingAssistantMessage(sessionId, (lastMessage) => ({
              ...lastMessage,
              role: 'assistant',
              pending: true,
            }));
            return;
          }

          if (event.type === 'tool_event') {
            updatePendingAssistantMessage(sessionId, (lastMessage) => ({
              ...lastMessage,
              role: 'assistant',
              toolEvents: [...lastMessage.toolEvents, event.tool_event],
              blocks: appendToolToBlocks(lastMessage.blocks, event.tool_event),
              pending: true,
            }));
            return;
          }

          if (event.type === 'context_input') {
            updateContextInputMapFromTranscript(sessionId, event.conversation);
            return;
          }

          if (event.type === 'error') {
            streamError = event.error;
            return;
          }

          streamCompleted = true;
          updatePendingAssistantMessage(sessionId, (lastMessage) => {
            const nextBlocks = event.blocks || lastMessage.blocks;
            const nextText = getTextFromBlocks(nextBlocks) || event.answer || lastMessage.text;

            return {
              role: 'assistant',
              text: nextText,
              attachments: [],
              toolEvents: event.tool_events || lastMessage.toolEvents,
              blocks: nextBlocks,
              pending: false,
              sourceText: message,
            };
          });

          applySidebarPayload(
            event,
            isViewingSession(sessionId)
              ? event.session.project_id || currentProjectIdRef.current
              : currentProjectIdRef.current,
          );
          updateContextInputMapFromTranscript(sessionId, event.context_input);

          if (isViewingSession(sessionId) && event.session.scope === 'project') {
            const nextProjectId = event.session.project_id || currentProjectIdRef.current;
            setCurrentProjectId(nextProjectId || '');
            setCurrentProjectSessionId(event.session.id);
            if (nextProjectId) {
              setProjectExpansions((previous) => ({
                ...previous,
                [nextProjectId]: true,
              }));
            }
          } else if (isViewingSession(sessionId)) {
            setCurrentChatSessionId(event.session.id);
          }

          setPendingContextRestores((previous) => {
            const next = { ...previous };
            delete next[sessionId];
            return next;
          });

          if (Array.isArray(event.tool_events) && event.tool_events.length) {
            showToast('Tool calls: ' + event.tool_events.length + '.');
          }
        },
        {
          signal: streamController.signal,
        },
      );

      if (streamError) {
        throw new Error(streamError);
      }

      if (!streamCompleted) {
        throw new Error('Stream interrupted.');
      }
    } catch (error) {
      if (sessionId && (stopRequestedSessionIdsRef.current.has(sessionId) || isAbortError(error))) {
        await stopRequestPromisesRef.current[sessionId];
        finalizePendingAssistantMessage(sessionId, message);
        showToast('Stopped this response.');
        return;
      }

      if (sessionId) {
        setConversations((previous) => {
          const history = [...(previous[sessionId] || [])];
          if (history.length) {
            history[history.length - 1] = {
              role: 'assistant',
              text: getThrownMessage(error),
              attachments: [],
              toolEvents: [],
              blocks: [],
              pending: false,
              sourceText: message,
            };
          }

          return {
            ...previous,
            [sessionId]: history,
          };
        });
      }

      showToast(getThrownMessage(error));
    } finally {
      if (sessionId) {
        clearSessionRunning(sessionId, streamController || undefined);
      }
    }
  }

  function handleStopSending() {
    if (!currentSessionId || !streamAbortControllersRef.current[currentSessionId]) {
      return;
    }

    abortSessionRequest(currentSessionId);
  }

  async function handleSaveOpenAISettings() {
    setIsSavingSettings(true);
    const payload = buildSettingsSavePayload(settingsDraftRef.current, {
      defaultReasoningEffort: currentReasoningRef.current,
      uiPreferences: currentUiPreferences(),
    });
    const snapshot = settingsPayloadSnapshot(payload);
    settingsAutosaveLatestSnapshotRef.current = snapshot;
    try {
      const response = await saveSettingsRequest(payload);
      if (settingsAutosaveLatestSnapshotRef.current !== snapshot) {
        return;
      }
      settingsAutosaveSnapshotRef.current = snapshot;
      settingsAutosaveLatestSnapshotRef.current = snapshot;
      syncSavedSettingsMetadata(response.settings, response.models);
      showToast(SETTINGS_SAVED_TOAST);
    } catch (error) {
      showToast(getThrownMessage(error));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function handleClearApiKey() {
    setIsSavingSettings(true);
    try {
      const response = await saveSettingsRequest({
        ...buildSettingsSavePayload(settingsDraftRef.current, {
          clearProviderApiKeyId: settingsDraftRef.current.active_provider_id,
          defaultReasoningEffort: currentReasoningRef.current,
          uiPreferences: currentUiPreferences(),
        }),
        clear_api_key: true,
      });

      syncSettingsState(response.settings, response.models);
      showToast(SETTINGS_API_KEY_CLEARED_TOAST);
    } catch (error) {
      showToast(getThrownMessage(error));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function handleCopyMessage(text: string) {
    try {
      await copyText(text);
      showToast(COPY_TOAST);
    } catch (error) {
      showToast(getThrownMessage(error));
    }
  }

  async function handleEditMessage(messageIndex: number) {
    const history = currentSessionId ? conversations[currentSessionId] || [] : [];
    const targetMessage = history[messageIndex];
    if (!targetMessage || targetMessage.role !== 'user') {
      return;
    }

    const nextHistory = history.slice(0, messageIndex);

    setComposerValue(targetMessage.text);
    setConversations((previous) => ({
      ...previous,
      [currentSessionId]: nextHistory,
    }));
    setView('chat');
    focusComposer();

    if (!currentSessionId) {
      showToast(EDIT_TOAST);
      return;
    }

    try {
      const response = await truncateSessionRequest(currentSessionId, messageIndex);
      applySidebarPayload(response);
      setConversations((previous) => ({
        ...previous,
        [currentSessionId]: normalizeConversation(response.conversation),
      }));
      updateContextInputMapFromTranscript(currentSessionId, response.context_input);
      showToast(EDIT_TOAST);
    } catch (error) {
      setConversations((previous) => ({
        ...previous,
        [currentSessionId]: nextHistory,
      }));
      showToast(getThrownMessage(error));
    }
  }

  function handleRegenerateMessage(sourceText: string) {
    if (!sourceText) {
      showToast(REGENERATE_MISSING_TOAST);
      return;
    }

    setComposerValue(sourceText);
    setView('chat');
    focusComposer();
    showToast(REGENERATE_TOAST);
  }

  async function handleDeleteMessage(messageIndex: number) {
    if (!currentSessionId) {
      showToast('No active session found.');
      return;
    }

    const sessionId = currentSessionId;
    const history = conversations[sessionId] || [];
    const targetMessage = history[messageIndex];
    if (!targetMessage) {
      showToast('Message not found.');
      return;
    }

    abortSessionRequest(sessionId);

    try {
      const response = await deleteMessageRequest(sessionId, messageIndex);
      applySidebarPayload(response);
      setConversations((previous) => ({
        ...previous,
        [sessionId]: normalizeConversation(response.conversation),
      }));
      updateContextInputMapFromTranscript(sessionId, response.context_input);
      showToast('Message deleted.');
    } catch (error) {
      showToast(getThrownMessage(error));
    }
  }

  function handleContextWorkbenchHistoryChange(sessionId: string, history: ContextWorkbenchHistoryEntry[]) {
    setContextWorkbenchHistories((previous) => ({
      ...previous,
      [sessionId]: history,
    }));
  }

  function handleContextWorkbenchConversationChange(sessionId: string, conversation: MessageRecord[]) {
    setConversations((previous) => ({
      ...previous,
      [sessionId]: conversation,
    }));
  }

  function handleContextRevisionHistoryChange(sessionId: string, revisions: ContextRevisionSummary[]) {
    setContextRevisionHistories((previous) => ({
      ...previous,
      [sessionId]: revisions,
    }));
  }

  function handlePendingContextRestoreChange(sessionId: string, pendingRestore: PendingContextRestore | null) {
    setPendingContextRestores((previous) => {
      const next = { ...previous };
      if (pendingRestore) {
        next[sessionId] = pendingRestore;
      } else {
        delete next[sessionId];
      }
      return next;
    });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (view === 'chat') {
        void handleSend();
      }
    }
  }

  function handleToggleDropdown(
    dropdownId: Exclude<DropdownId, null>,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    event.stopPropagation();
    setOpenDropdown((previous) => (previous === dropdownId ? null : dropdownId));
  }

  function handlePermissionSelect(option: PermissionOption) {
    setCurrentPermission(option);
    setOpenDropdown(null);
    showToast(option.toastMessage || 'Permission: ' + option.label + '.');
  }

  function handleOpenModelPicker() {
    setOpenDropdown(null);
    setIsModelPickerOpen(true);
  }

  function handleModelSelect(providerId: string, model: ResponseProviderModel) {
    const modelId = (model.id || model.label || '').trim();
    if (!modelId) {
      return;
    }

    const previousDraft = settingsDraftRef.current;
    const targetProvider = previousDraft.response_providers.find((provider) => provider.id === providerId);
    if (!targetProvider) {
      return;
    }

    if (previousDraft.active_provider_id === providerId && previousDraft.default_model === modelId && currentModel === modelId) {
      setIsModelPickerOpen(false);
      return;
    }

    const requestId = modelSelectionRequestIdRef.current + 1;
    modelSelectionRequestIdRef.current = requestId;
    const nextDraft = applyProviderModelSelection(previousDraft, providerId, modelId);
    const savePayload = buildSettingsSavePayload(nextDraft, {
      activeProviderId: providerId,
      defaultReasoningEffort: currentReasoningRef.current,
      uiPreferences: currentUiPreferences(),
    });

    if (settingsAutosaveTimerRef.current) {
      window.clearTimeout(settingsAutosaveTimerRef.current);
      settingsAutosaveTimerRef.current = null;
    }

    flushSync(() => {
      currentModelRef.current = modelId;
      settingsDraftRef.current = nextDraft;
      const saveSnapshot = settingsPayloadSnapshot(savePayload);
      settingsAutosaveSnapshotRef.current = saveSnapshot;
      settingsAutosaveLatestSnapshotRef.current = saveSnapshot;
      setCurrentModel(modelId);
      setSettingsDraft(nextDraft);
      setIsModelPickerOpen(false);
      setModels((previous) =>
        Array.from(new Set([modelId, ...targetProvider.models.map((item) => item.id), ...previous].filter(Boolean))),
      );
    });
    showToast('Model: ' + modelId + '.');
    void saveSettingsRequest(savePayload)
      .then((response) => {
        if (modelSelectionRequestIdRef.current !== requestId) {
          return;
        }
        syncSettingsState(response.settings, response.models, {
          preserveCurrentModel: true,
          preserveCurrentReasoning: true,
        });
      })
      .catch((error) => {
        if (modelSelectionRequestIdRef.current !== requestId) {
          return;
        }

        const previousActiveProvider = previousDraft.response_providers.find((provider) => provider.id === previousDraft.active_provider_id);
        const previousModel = previousActiveProvider?.default_model || previousDraft.default_model || currentModelRef.current;
        const previousPayload = buildSettingsSavePayload(previousDraft, {
          defaultReasoningEffort: currentReasoningRef.current,
          uiPreferences: currentUiPreferences(),
        });
        settingsDraftRef.current = previousDraft;
        const previousSnapshot = settingsPayloadSnapshot(previousPayload);
        settingsAutosaveSnapshotRef.current = previousSnapshot;
        settingsAutosaveLatestSnapshotRef.current = previousSnapshot;
        currentModelRef.current = previousModel;
        setSettingsDraft(previousDraft);
        setCurrentModel(previousModel);
        showToast(getThrownMessage(error));
      });
  }

  function handleReasoningSelect(option: ReasoningOption) {
    const requestId = reasoningSaveRequestIdRef.current + 1;
    reasoningSaveRequestIdRef.current = requestId;
    const previousReasoning = currentReasoningRef.current;
    flushSync(() => {
      currentReasoningRef.current = option.value;
      setCurrentReasoning(option.value);
      setOpenDropdown(null);
    });
    showToast('Reasoning: ' + option.label + '.');
    void saveSettingsRequest(
      buildSettingsSavePayload(settingsDraftRef.current, {
        defaultReasoningEffort: option.value,
        uiPreferences: currentUiPreferences(),
      }),
    )
      .then((response) => {
        if (reasoningSaveRequestIdRef.current !== requestId) {
          return;
        }
        syncSettingsState(response.settings, response.models, {
          preserveCurrentModel: true,
          preserveCurrentReasoning: true,
        });
      })
      .catch((error) => {
        if (reasoningSaveRequestIdRef.current !== requestId) {
          return;
        }
        currentReasoningRef.current = previousReasoning;
        setCurrentReasoning(previousReasoning);
        showToast(getThrownMessage(error));
      });
  }

  function handleToggleSidebar() {
    setUserSidebarCollapsed((previous) => {
      const next = !previous;
      if (next) {
        showToast(COLLAPSE_TOAST);
      }
      return next;
    });
  }

  function handleToggleSidebarMode() {
    const nextMode = sidebarMode === 'projects' ? 'chats' : 'projects';
    setSidebarMode(nextMode);
    setCurrentSessionId('');
  }

  function handleThemeModeChange(nextMode: AppearanceMode) {
    setThemeMode(nextMode);
  }

  function handleToggleServiceHints(enabled: boolean) {
    setServiceHintsEnabled(enabled);
    showToast(enabled ? SETTINGS_HINTS_ON_TOAST : SETTINGS_HINTS_OFF_TOAST);
  }

  function handleToggleContextMap() {
    setContextMap((previous) => ({
      ...previous,
      stage: ((previous.stage + 1) % 3) as 0 | 1 | 2,
    }));
  }

  const handleJumpToMainChatMessage = useCallback((messageIndex: number) => {
    const messageList = messageListRef.current;
    if (!messageList) {
      return;
    }

    const targetNode = messageList.querySelector<HTMLElement>('[data-message-index="' + messageIndex + '"]');
    if (!targetNode) {
      return;
    }

    messageList.scrollTo({
      top: Math.max(targetNode.offsetTop - 12, 0),
      behavior: 'smooth',
    });
  }, []);

  return (
    <div className="app-container">
      <Toast message={toastState.message} visible={toastState.visible} />

      <div className={'title-bar ' + (contextMap.stage === 2 ? 'main-blurred' : '')}>
        <div className="title-bar-left">
          <button className="sidebar-toggle" onClick={handleToggleSidebar} title="切换侧栏">
            <i className="ph-light ph-sidebar-simple" />
          </button>
          <div className="menu-item">文件</div>
          <div className="menu-item">编辑</div>
          <div className="menu-item">查看</div>
          <div className="menu-item">窗口</div>
          <div className="menu-item">帮助</div>
        </div>
        <div className="title-bar-right">
          <button className="window-btn" title="最小化" onClick={() => window.electronAPI?.minimize?.()}>
            <i className="ph-light ph-minus" />
          </button>
          <button className="window-btn" title="最大化" onClick={() => window.electronAPI?.maximize?.()}>
            <i className="ph-light ph-square" />
          </button>
          <button className="window-btn close" title="关闭" onClick={() => window.electronAPI?.close?.()}>
            <i className="ph-light ph-x" />
          </button>
        </div>
      </div>

      <div className="main-layout">
        {view === 'settings' ? (
          <SettingsView
            availableModels={models}
            fetchingProviderId={fetchingProviderId}
            isSaving={isSavingSettings}
            isSidebarResizing={isResizingLeft}
            openAISettings={openAISettings}
            savingProviderId={savingProviderId}
            settingsDraft={settingsDraft}
            serviceHintsEnabled={serviceHintsEnabled}
            resolvedThemeMode={resolvedThemeMode}
            themeMode={themeMode}
            view={view}
            onClearApiKey={() => {
              void handleClearApiKey();
            }}
            onDraftChange={(patch) => {
              applySettingsDraftPatch(patch);
            }}
            onProviderDraftChange={(providerId, patch) => {
              updateProviderDraftState(providerId, patch);
            }}
            onProviderAdd={(providerType, providerName) => addProviderDraftState(providerType, providerName)}
            onProviderDelete={(providerId) => deleteProviderDraftState(providerId)}
            onProviderLoadModels={(providerId) => loadProviderModelCandidates(providerId)}
            onProviderPersist={(providerId, options) => {
              void persistProviderSettings(providerId, options);
            }}
            onSaveOpenAISettings={() => {
              void handleSaveOpenAISettings();
            }}
            onSidebarResizeStart={startResizingLeft}
            onSwitchView={setView}
            onThemeModeChange={handleThemeModeChange}
            onToggleServiceHints={handleToggleServiceHints}
          />
        ) : (
          <>
            <Sidebar
              chatSessions={chatSessions}
              currentProjectId={currentProjectId}
              currentSessionId={currentSessionId}
              isSidebarResizing={isResizingLeft}
              runningSessionIds={runningSessionIds}
              projectExpansions={projectExpansions}
              projects={projects}
              sidebarMode={sidebarMode}
              view={view}
              onAddItem={() => {
                void handleAddSidebarItem();
              }}
              onAutomation={() => {}}
              onPlugins={() => {}}
              onProjectArchive={(project) => {
                void handleArchiveProjectSessions(project);
              }}
              onProjectDelete={(project) => {
                void handleDeleteProject(project);
              }}
              onProjectOpenParent={(project) => {
                void handleOpenProjectParent(project);
              }}
              onProjectPin={(project) => {
                void handlePinProject(project);
              }}
              onProjectRename={(project) => {
                void handleRenameProject(project);
              }}
              onProjectSelect={handleProjectSelect}
              onSearch={() => {}}
              onSessionCreate={(projectId) => {
                setCurrentProjectId(projectId);
                setProjectExpansions((previous) => ({
                  ...previous,
                  [projectId]: true,
                }));
                void createSession(false, { scope: 'project', projectId });
              }}
              onSessionDelete={(sessionId) => {
                void handleDeleteSession(sessionId);
              }}
              onSessionSelect={handleSwitchSession}
              onSwitchView={setView}
              onToggleMode={handleToggleSidebarMode}
            />

            <div className={'resizer resizer-left ' + (isResizingLeft ? 'dragging' : '')} onMouseDown={startResizingLeft} />

            <main className={'view-container ' + (contextMap.stage === 2 ? 'main-blurred' : '')}>
              <ChatView
                attachments={composerAttachments}
                composerValue={composerValue}
                currentModel={currentModel}
                currentPermission={currentPermission}
                currentReasoningLabel={currentReasoningLabel}
                currentReasoningValue={currentReasoning}
                dropdownId={openDropdown}
                fileInputRef={fileInputRef}
                hasMessages={hasMessages}
                headerTitle={headerTitle}
                isSending={isSending}
                messageListRef={messageListRef}
                messages={currentConversation}
                contextMap={contextMap}
                onAttachmentInputChange={handleComposerAttachmentChange}
                onToggleContextMap={handleToggleContextMap}
                onComposerChange={(event: ChangeEvent<HTMLTextAreaElement>) => setComposerValue(event.target.value)}
                onComposerKeyDown={handleComposerKeyDown}
                onComposerPlus={() => {
                  fileInputRef.current?.click();
                }}
                onCopyMessage={(text) => {
                  void handleCopyMessage(text);
                }}
                onDeleteMessage={handleDeleteMessage}
                onEditMessage={handleEditMessage}
                onRegenerateMessage={handleRegenerateMessage}
                onRemoveAttachment={handleRemoveAttachment}
                onOpenModelPicker={handleOpenModelPicker}
                onSelectPermission={handlePermissionSelect}
                onSelectReasoning={handleReasoningSelect}
                onSend={() => {
                  void handleSend();
                }}
                onStop={handleStopSending}
                onToggleDropdown={handleToggleDropdown}
                permissionOptions={PERMISSION_OPTIONS}
                reasoningOptions={reasoningOptions}
                textareaRef={textareaRef}
                view={view}
                welcomeAnimationKey={welcomeAnimationKey}
                welcomeText={welcomeText}
              />
            </main>

            <ChatModelPicker
              activeProviderId={settingsDraft.active_provider_id}
              currentModel={currentModel}
              open={isModelPickerOpen}
              providers={settingsDraft.response_providers}
              onClose={() => setIsModelPickerOpen(false)}
              onSelectModel={handleModelSelect}
            />

            <div
              className={'resizer resizer-right ' + (isResizingRight ? 'dragging ' : '') + (contextMap.stage === 0 ? 'hidden' : '')}
              onMouseDown={startResizingRight}
            />

            {isContextMapMounted && (
            <ContextMapSidebar
              stage={contextMap.stage}
              messages={currentContextMapMessages}
              onToggle={handleToggleContextMap}
              onJumpToMessage={handleJumpToMainChatMessage}
              sessionId={currentSessionId}
              isMainChatBusy={isSending}
              contextWorkbenchHistory={contextWorkbenchHistories[currentSessionId] || []}
              contextRevisionHistory={contextRevisionHistories[currentSessionId] || []}
              pendingContextRestore={pendingContextRestores[currentSessionId] || null}
              reasoningOptions={reasoningOptions}
              onContextWorkbenchHistoryChange={handleContextWorkbenchHistoryChange}
              onContextWorkbenchConversationChange={handleContextWorkbenchConversationChange}
              onContextInputChange={updateContextInputMap}
              onContextRevisionHistoryChange={handleContextRevisionHistoryChange}
              onPendingContextRestoreChange={handlePendingContextRestoreChange}
              onEnsureSession={ensureSession}
            />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function model_options_fallback(defaultModel: string) {
  const ordered = [defaultModel, 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'];
  return Array.from(new Set(ordered.filter(Boolean)));
}
