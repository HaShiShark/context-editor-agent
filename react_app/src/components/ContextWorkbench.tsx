import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, MouseEvent } from 'react';
import { flushSync } from 'react-dom';

import {
  cancelActiveRequest,
  clearContextWorkbenchHistoryRequest,
  deleteContextWorkbenchMessageRequest,
  fetchContextWorkbenchSettings,
  fetchContextWorkbenchSuggestionsRequest,
  restoreContextRevisionRequest,
  saveContextWorkbenchSettingsRequest,
  streamContextChatRequest,
} from '../api';
import {
  DEFAULT_CONTEXT_TOKEN_THRESHOLDS,
  normalizeContextTokenThresholds,
  type ContextMessageTokenStat,
  type ContextTokenThresholds,
} from '../contextTokenWeight';
import type {
  ContextRevisionSummary,
  ContextWorkbenchHistoryEntry,
  ContextWorkbenchSuggestionNode,
  ContextWorkbenchSuggestionStats,
  ContextWorkbenchToolCatalogItem,
  MessageRecord,
  PendingContextRestore,
  ReasoningOption,
  ResponseProviderDraft,
  ResponseProviderModel,
  ResponseProviderSettings,
} from '../types';
import { copyText, getReasoningLabel, normalizeConversation } from '../utils';
import ChatModelPicker from './ChatModelPicker';
import Dropdown from './Dropdown';
import MarkdownRenderer from './MarkdownRenderer';

type WorkbenchTab = 'suggestions' | 'manual' | 'restore' | 'settings';

interface ManualWorkbenchMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

interface ContextWorkbenchProps {
  messages: MessageRecord[];
  messageTokenStats: ContextMessageTokenStat[];
  selectedNodeIndexes: number[];
  criticalNodeIndexes: number[];
  tokenThresholds: ContextTokenThresholds;
  sessionId: string;
  isMainChatBusy: boolean;
  history: ContextWorkbenchHistoryEntry[];
  revisions: ContextRevisionSummary[];
  pendingRestore: PendingContextRestore | null;
  reasoningOptions: ReasoningOption[];
  onHistoryChange: (sessionId: string, history: ContextWorkbenchHistoryEntry[]) => void;
  onConversationChange: (sessionId: string, conversation: MessageRecord[]) => void;
  onRevisionHistoryChange: (sessionId: string, revisions: ContextRevisionSummary[]) => void;
  onPendingRestoreChange: (sessionId: string, pendingRestore: PendingContextRestore | null) => void;
  onEnsureSession: () => Promise<string>;
  onTokenThresholdsChange: (thresholds: ContextTokenThresholds) => void;
}

const DEFAULT_WORKBENCH_MODELS = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.2'];
const DEFAULT_WORKBENCH_PROVIDER_ID = 'openai';
const EMPTY_SUGGESTION_STATS: ContextWorkbenchSuggestionStats = {
  total_token_count: 0,
  tool_token_count: 0,
};

const WORKBENCH_TABS: Array<{
  id: WorkbenchTab;
  label: string;
  icon: string;
}> = [
  { id: 'suggestions', label: '建议', icon: 'ph-lightbulb' },
  { id: 'manual', label: '手动', icon: 'ph-hand-pointing' },
  { id: 'restore', label: '恢复', icon: 'ph-arrow-counter-clockwise' },
  { id: 'settings', label: '设置', icon: 'ph-gear' },
];

function createManualMessage(
  role: ManualWorkbenchMessage['role'],
  content: string,
  options: Partial<ManualWorkbenchMessage> = {},
): ManualWorkbenchMessage {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
    pending: false,
    ...options,
  };
}

function buildManualMessagesFromHistory(history: ContextWorkbenchHistoryEntry[]): ManualWorkbenchMessage[] {
  if (!history.length) {
    return [];
  }

  return history.map((entry, index) =>
    createManualMessage(entry.role, entry.content, {
      id: `history-${index}-${entry.role}`,
    }),
  );
}

function getThrownMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatNodeReferenceSegments(nodeNumbers: number[]) {
  if (!nodeNumbers.length) {
    return [];
  }

  const segments: string[] = [];
  let rangeStart = nodeNumbers[0];
  let previous = nodeNumbers[0];

  for (let index = 1; index < nodeNumbers.length; index += 1) {
    const current = nodeNumbers[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }

    segments.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
    rangeStart = current;
    previous = current;
  }

  segments.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
  return segments;
}

function statusLabel(status: ContextWorkbenchToolCatalogItem['status']) {
  return status === 'available' ? '可用' : '预览';
}

function toWorkbenchProviderDraft(provider: ResponseProviderSettings): ResponseProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    provider_type: provider.provider_type,
    enabled: provider.enabled,
    supports_model_fetch: provider.supports_model_fetch,
    supports_responses: provider.supports_responses,
    api_base_url: provider.api_base_url || '',
    api_key_input: '',
    clear_api_key: false,
    default_model: provider.default_model || '',
    models: Array.isArray(provider.models) ? provider.models : [],
    last_sync_at: provider.last_sync_at || '',
    last_sync_error: provider.last_sync_error || '',
  };
}

function inferWorkbenchProviderId(modelId: string, providers: ResponseProviderDraft[]) {
  const cleanedModelId = modelId.trim();
  if (cleanedModelId) {
    const matchedProvider = providers.find((provider) =>
      provider.models.some((model) => (model.id || '').trim() === cleanedModelId),
    );
    if (matchedProvider) {
      return matchedProvider.id;
    }
  }

  return providers.find((provider) => provider.enabled && provider.models.length > 0)?.id || 'openai';
}

function resolveWorkbenchSelection(modelId: string, providerId: string, providers: ResponseProviderDraft[]) {
  const cleanedModelId = modelId.trim();
  const cleanedProviderId = providerId.trim();
  const matchedProvider = providers.find((provider) => provider.id === cleanedProviderId);
  const matchedModel =
    matchedProvider?.models.find((model) => (model.id || '').trim() === cleanedModelId) ||
    providers.find((provider) => provider.models.some((model) => (model.id || '').trim() === cleanedModelId))
      ?.models.find((model) => (model.id || '').trim() === cleanedModelId);

  if (matchedModel) {
    return {
      providerId: matchedProvider?.models.some((model) => (model.id || '').trim() === cleanedModelId)
        ? matchedProvider.id
        : inferWorkbenchProviderId(cleanedModelId, providers),
      modelId: matchedModel.id || matchedModel.label || DEFAULT_WORKBENCH_MODELS[0],
    };
  }

  const fallbackProvider = providers.find((provider) => provider.enabled && provider.models.length > 0);
  return {
    providerId: fallbackProvider?.id || cleanedProviderId || DEFAULT_WORKBENCH_PROVIDER_ID,
    modelId: fallbackProvider?.default_model || fallbackProvider?.models[0]?.id || cleanedModelId || DEFAULT_WORKBENCH_MODELS[0],
  };
}

function workbenchProviderName(provider: ResponseProviderDraft | undefined) {
  if (!provider) {
    return '未选择供应商';
  }
  return provider.name.trim() || provider.id;
}

function formatChangeTypeLabel(changeType: string) {
  switch (changeType) {
    case 'delete':
      return '删除';
    case 'replace':
      return '替换';
    case 'compress':
      return '压缩';
    case 'mixed':
      return '混合';
    default:
      return '更新';
  }
}

function formatRevisionMeta(revision: ContextRevisionSummary) {
  const revisionNumber = revision.revision_number || 0;
  const operationCount = revision.operation_count || 0;
  const nodeCount = revision.node_count || 0;
  const changedSegments = formatNodeReferenceSegments(revision.changed_nodes || []);
  const parts = [
    `第 ${revisionNumber} 版`,
    `${operationCount} 次改动`,
    `${nodeCount} 个节点`,
  ];

  if (changedSegments.length) {
    parts.push(`节点 #${changedSegments.join(' / ')}`);
  }

  return parts.join(' · ');
}

function buildRestoreActionLabel(targetRevision: ContextRevisionSummary) {
  const targetRevisionNumber = targetRevision.revision_number || 0;
  return `切到第 ${targetRevisionNumber} 版`;
}

function formatTokenCount(value: number) {
  return value.toLocaleString('zh-CN');
}

function parseTokenThresholdDraft(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function formatSuggestionRoleLabel(role: ContextWorkbenchSuggestionNode['role']) {
  return role === 'user' ? '用户' : '助手';
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function localizeToolCatalogItem(tool: ContextWorkbenchToolCatalogItem) {
  switch (tool.id) {
    case 'preview_context_selection':
      return {
        label: '查看概览',
        description: '查看当前选中节点，或者先基于整份快照做一轮概览判断。',
      };
    case 'get_context_node_details':
      return {
        label: '展开节点详情',
        description: '把一个或多个节点展开成完整内容和可编辑条目视图，再决定要不要编辑。',
      };
    case 'delete_context_item':
      return {
        label: '删除单个条目',
        description: '删除某个节点里的一个条目。',
      };
    case 'replace_context_item':
      return {
        label: '替换单个条目',
        description: '把某个节点里的一个条目替换成新的内容。',
      };
    case 'compress_context_item':
      return {
        label: '压缩单个条目',
        description: '把某个条目压缩成更短的版本，同时保留原来的条目类型。',
      };
    case 'compress_context_nodes':
      return {
        label: '压缩节点',
        description: '把一个或多个节点压缩成新的摘要节点，作用在当前工作快照上。',
      };
    case 'delete_context_nodes':
      return {
        label: '删除节点',
        description: '从当前工作快照里删除一个或多个节点。',
      };
    default:
      return {
        label: tool.label,
        description: tool.description,
      };
  }
}

export default function ContextWorkbench({
  messages,
  messageTokenStats,
  selectedNodeIndexes,
  criticalNodeIndexes,
  tokenThresholds,
  sessionId,
  isMainChatBusy,
  history,
  revisions,
  pendingRestore,
  reasoningOptions,
  onHistoryChange,
  onConversationChange,
  onRevisionHistoryChange,
  onPendingRestoreChange,
  onEnsureSession,
  onTokenThresholdsChange,
}: ContextWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('suggestions');
  const [manualDraft, setManualDraft] = useState('');
  const [manualReasoning, setManualReasoning] = useState('default');
  const [isManualReasoningOpen, setIsManualReasoningOpen] = useState(false);
  const [manualMessages, setManualMessages] = useState<ManualWorkbenchMessage[]>(
    () => buildManualMessagesFromHistory(history),
  );
  const [isManualSending, setIsManualSending] = useState(false);
  const [isRestoreBusy, setIsRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [manualFeedback, setManualFeedback] = useState('');
  const [manualFeedbackError, setManualFeedbackError] = useState(false);
  const [workbenchModelDraft, setWorkbenchModelDraft] = useState(DEFAULT_WORKBENCH_MODELS[0]);
  const [workbenchProviderDraft, setWorkbenchProviderDraft] = useState(DEFAULT_WORKBENCH_PROVIDER_ID);
  const [tokenWarningThresholdDraft, setTokenWarningThresholdDraft] = useState(
    String(DEFAULT_CONTEXT_TOKEN_THRESHOLDS.warningThreshold),
  );
  const [tokenCriticalThresholdDraft, setTokenCriticalThresholdDraft] = useState(
    String(DEFAULT_CONTEXT_TOKEN_THRESHOLDS.criticalThreshold),
  );
  const [availableProviders, setAvailableProviders] = useState<ResponseProviderDraft[]>([]);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [toolCatalog, setToolCatalog] = useState<ContextWorkbenchToolCatalogItem[]>([]);
  const [suggestionStats, setSuggestionStats] = useState<ContextWorkbenchSuggestionStats>(EMPTY_SUGGESTION_STATS);
  const [suggestionNodes, setSuggestionNodes] = useState<ContextWorkbenchSuggestionNode[]>([]);
  const [isSuggestionsLoading, setIsSuggestionsLoading] = useState(true);
  const [suggestionsError, setSuggestionsError] = useState('');
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const manualListRef = useRef<HTMLDivElement>(null);
  const manualTextareaRef = useRef<HTMLTextAreaElement>(null);
  const manualAbortControllerRef = useRef<AbortController | null>(null);
  const manualActiveSessionIdRef = useRef('');
  const manualStopRequestedRef = useRef(false);
  const manualStopRequestRef = useRef<Promise<unknown> | null>(null);

  const selectedNodeNumbers = useMemo(
    () => [...selectedNodeIndexes].sort((left, right) => left - right).map((index) => index + 1),
    [selectedNodeIndexes],
  );
  const selectedNodeReferenceSegments = useMemo(
    () => formatNodeReferenceSegments(selectedNodeNumbers),
    [selectedNodeNumbers],
  );
  const selectedWorkbenchProvider = useMemo(
    () => availableProviders.find((provider) => provider.id === workbenchProviderDraft),
    [availableProviders, workbenchProviderDraft],
  );
  const criticalNodeIndexSet = useMemo(
    () => new Set(criticalNodeIndexes),
    [criticalNodeIndexes],
  );
  const localSuggestionStats = useMemo(
    () => ({
      total_token_count: messageTokenStats.reduce((total, stat) => total + stat.tokens, 0),
      tool_token_count: messageTokenStats.reduce((total, stat) => total + stat.toolTokens, 0),
    }),
    [messageTokenStats],
  );
  const localSuggestionNodes = useMemo(
    () =>
      messageTokenStats
        .map((stat): ContextWorkbenchSuggestionNode => ({
          node_index: stat.nodeIndex,
          node_number: stat.nodeNumber,
          role: stat.role,
          token_count: stat.tokens,
          tool_token_count: stat.toolTokens,
          preview: '',
        }))
        .sort((left, right) => right.token_count - left.token_count || left.node_number - right.node_number),
    [messageTokenStats],
  );
  const criticalSuggestionNodes = useMemo(
    () => localSuggestionNodes.filter((node) => criticalNodeIndexSet.has(node.node_index)),
    [localSuggestionNodes, criticalNodeIndexSet],
  );
  const manualHistoryKey = useMemo(() => JSON.stringify(history || []), [history]);
  const isWorkbenchBusy = isManualSending || isRestoreBusy;
  const isManualComposerLocked = isMainChatBusy || isWorkbenchBusy;
  const manualReasoningDisabled = reasoningOptions.length === 0;
  const isRestoreLocked = isMainChatBusy || isRestoreBusy;
  const hasClearableManualHistory = manualMessages.some((message) => !message.pending);
  const currentManualReasoningLabel = getReasoningLabel(manualReasoning, reasoningOptions);
  const nextTokenThresholds = useMemo(() => {
    const warningThreshold = parseTokenThresholdDraft(
      tokenWarningThresholdDraft,
      tokenThresholds.warningThreshold,
    );
    const criticalThreshold = parseTokenThresholdDraft(
      tokenCriticalThresholdDraft,
      tokenThresholds.criticalThreshold,
    );

    return {
      warningThreshold,
      criticalThreshold,
    };
  }, [tokenCriticalThresholdDraft, tokenThresholds, tokenWarningThresholdDraft]);
  const tokenThresholdError =
    nextTokenThresholds.warningThreshold >= nextTokenThresholds.criticalThreshold
      ? '红色阈值必须大于黄色阈值'
      : '';

  void pendingRestore;

  useEffect(() => {
    let cancelled = false;

    async function loadWorkbenchSettings() {
      setIsSettingsLoading(true);
      setSettingsError('');

      try {
        const response = await fetchContextWorkbenchSettings();
        if (cancelled) {
          return;
        }

        const nextModel = response.settings.context_workbench_model || DEFAULT_WORKBENCH_MODELS[0];
        const nextProviders = Array.isArray(response.response_providers)
          ? response.response_providers.map(toWorkbenchProviderDraft)
          : [];
        const nextSelection = resolveWorkbenchSelection(
          nextModel,
          response.settings.context_workbench_provider_id || '',
          nextProviders,
        );
        setWorkbenchModelDraft(nextSelection.modelId);
        setWorkbenchProviderDraft(nextSelection.providerId);
        const nextThresholds = normalizeContextTokenThresholds({
          warningThreshold: response.settings.context_token_warning_threshold,
          criticalThreshold: response.settings.context_token_critical_threshold,
        });
        setTokenWarningThresholdDraft(String(nextThresholds.warningThreshold));
        setTokenCriticalThresholdDraft(String(nextThresholds.criticalThreshold));
        onTokenThresholdsChange(nextThresholds);
        setAvailableProviders(nextProviders);
        setToolCatalog(response.tool_catalog || []);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setSettingsError(getThrownMessage(error));
        setWorkbenchProviderDraft(DEFAULT_WORKBENCH_PROVIDER_ID);
        setAvailableProviders([]);
      } finally {
        if (!cancelled) {
          setIsSettingsLoading(false);
        }
      }
    }

    void loadWorkbenchSettings();
    return () => {
      cancelled = true;
    };
  }, [onTokenThresholdsChange]);

  useEffect(() => {
    let cancelled = false;

    async function loadSuggestions() {
      if (!sessionId) {
        setSuggestionStats(EMPTY_SUGGESTION_STATS);
        setSuggestionNodes([]);
        setSuggestionsError('');
        setIsSuggestionsLoading(false);
        return;
      }

      setIsSuggestionsLoading(true);
      setSuggestionsError('');

      try {
        const response = await fetchContextWorkbenchSuggestionsRequest({
          session_id: sessionId,
        });

        if (cancelled) {
          return;
        }

        setSuggestionStats(response.stats || EMPTY_SUGGESTION_STATS);
        setSuggestionNodes(response.nodes || []);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setSuggestionStats(EMPTY_SUGGESTION_STATS);
        setSuggestionNodes([]);
        setSuggestionsError(getThrownMessage(error));
      } finally {
        if (!cancelled) {
          setIsSuggestionsLoading(false);
        }
      }
    }

    void loadSuggestions();
    return () => {
      cancelled = true;
    };
  }, [messages, sessionId]);

  useEffect(() => {
    setManualMessages(buildManualMessagesFromHistory(history));
    setIsManualSending(false);
  }, [manualHistoryKey, sessionId]);

  useEffect(() => {
    setManualDraft('');
    setManualFeedback('');
    setManualFeedbackError(false);
  }, [sessionId]);

  useEffect(() => {
    if (!reasoningOptions.some((option) => option.value === manualReasoning)) {
      setManualReasoning(reasoningOptions.find((option) => option.value === 'default')?.value || reasoningOptions[0]?.value || 'default');
    }
  }, [manualReasoning, reasoningOptions]);

  useEffect(() => {
    if (activeTab !== 'manual') {
      return;
    }

    if (manualListRef.current) {
      manualListRef.current.scrollTop = manualListRef.current.scrollHeight;
    }
  }, [activeTab, manualMessages]);

  useLayoutEffect(() => {
    const textarea = manualTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 160 ? 'auto' : 'hidden';
  }, [manualDraft, activeTab]);

  function updatePendingManualMessage(
    messageId: string,
    updater: (message: ManualWorkbenchMessage) => ManualWorkbenchMessage,
  ) {
    setManualMessages((previous) =>
      previous.map((item) => (item.id === messageId ? updater(item) : item)),
    );
  }

  function handleManualReasoningSelect(event: MouseEvent<HTMLDivElement>, option: ReasoningOption) {
    event.preventDefault();
    event.stopPropagation();
    flushSync(() => {
      setManualReasoning(option.value);
      setIsManualReasoningOpen(false);
    });
  }

  async function handleSaveWorkbenchSettings() {
    const nextModel = workbenchModelDraft.trim();
    const nextProviderId = workbenchProviderDraft.trim() || inferWorkbenchProviderId(nextModel, availableProviders);
    if (!nextModel || !nextProviderId || isSettingsSaving) {
      return;
    }

    if (tokenThresholdError) {
      setSettingsMessage('');
      setSettingsError(tokenThresholdError);
      return;
    }

    setIsSettingsSaving(true);
    setSettingsMessage('');
    setSettingsError('');

    try {
      const response = await saveContextWorkbenchSettingsRequest({
        context_workbench_model: nextModel,
        context_workbench_provider_id: nextProviderId,
        context_token_warning_threshold: nextTokenThresholds.warningThreshold,
        context_token_critical_threshold: nextTokenThresholds.criticalThreshold,
      });
      const savedModel = response.settings.context_workbench_model || nextModel;
      const nextProviders = Array.isArray(response.response_providers)
        ? response.response_providers.map(toWorkbenchProviderDraft)
        : availableProviders;
      const nextSelection = resolveWorkbenchSelection(
        savedModel,
        response.settings.context_workbench_provider_id || nextProviderId,
        nextProviders,
      );
      setWorkbenchModelDraft(nextSelection.modelId);
      setWorkbenchProviderDraft(nextSelection.providerId);
      const savedThresholds = normalizeContextTokenThresholds({
        warningThreshold: response.settings.context_token_warning_threshold,
        criticalThreshold: response.settings.context_token_critical_threshold,
      });
      setTokenWarningThresholdDraft(String(savedThresholds.warningThreshold));
      setTokenCriticalThresholdDraft(String(savedThresholds.criticalThreshold));
      onTokenThresholdsChange(savedThresholds);
      setAvailableProviders(nextProviders);
      setToolCatalog(response.tool_catalog || []);
      setSettingsMessage('已保存，后面的上下文对话会使用这个模型。');
    } catch (error) {
      setSettingsError(getThrownMessage(error));
    } finally {
      setIsSettingsSaving(false);
    }
  }

  function finalizeStoppedManualMessage(messageId: string) {
    updatePendingManualMessage(messageId, (lastMessage) => ({
      ...lastMessage,
      content: lastMessage.content.trim() ? lastMessage.content : '已停止本次上下文模型对话。',
      pending: false,
    }));
  }

  function handleStopManualMessage() {
    const controller = manualAbortControllerRef.current;
    if (!controller) {
      return;
    }

    manualStopRequestedRef.current = true;
    const targetSessionId = manualActiveSessionIdRef.current || sessionId;
    if (targetSessionId) {
      manualStopRequestRef.current = cancelActiveRequest({
        session_id: targetSessionId,
        mode: 'context',
      }).catch(() => undefined);
    }
    controller.abort();
  }

  async function handleSendManualMessage() {
    const nextMessage = manualDraft.trim();
    if (!nextMessage || isManualComposerLocked) {
      return;
    }

    const userMessage = createManualMessage('user', nextMessage);
    const pendingMessage = createManualMessage('assistant', '', { pending: true });

    setManualMessages((previous) => [...previous, userMessage, pendingMessage]);
    setManualDraft('');
    setIsManualSending(true);
    setIsManualReasoningOpen(false);
    manualStopRequestedRef.current = false;
    manualStopRequestRef.current = null;
    const streamController = new AbortController();
    manualAbortControllerRef.current = streamController;
    manualActiveSessionIdRef.current = '';

    try {
      const targetSessionId = sessionId || await onEnsureSession();
      if (!targetSessionId) {
        throw new Error('没有可用会话');
      }

      manualActiveSessionIdRef.current = targetSessionId;
      if (streamController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      let streamError = '';
      let streamCompleted = false;

      await streamContextChatRequest(
        {
          session_id: targetSessionId,
          message: nextMessage,
          selected_node_indexes: selectedNodeIndexes,
          reasoning_effort: manualReasoning,
        },
        (event) => {
          if (event.type === 'delta') {
            if (event.kind === 'reasoning') {
              return;
            }
            updatePendingManualMessage(pendingMessage.id, (lastMessage) => ({
              ...lastMessage,
              content: `${lastMessage.content}${event.delta}`,
              pending: true,
            }));
            return;
          }

          if (event.type === 'reset') {
            updatePendingManualMessage(pendingMessage.id, (lastMessage) => ({
              ...lastMessage,
              pending: true,
            }));
            return;
          }

          if (event.type === 'reasoning_start' || event.type === 'reasoning_done') {
            return;
          }

          if (event.type === 'tool_event') {
            return;
          }

          if (event.type === 'error') {
            streamError = event.error;
            return;
          }

          streamCompleted = true;
          onHistoryChange(targetSessionId, event.history);
          onConversationChange(targetSessionId, normalizeConversation(event.conversation));
          onRevisionHistoryChange(targetSessionId, event.revisions || []);
          onPendingRestoreChange(targetSessionId, event.pending_restore || null);
          setManualMessages(buildManualMessagesFromHistory(event.history));
        },
        {
          signal: streamController.signal,
        },
      );

      if (streamError) {
        throw new Error(streamError);
      }

      if (!streamCompleted) {
        throw new Error('流式响应意外中断');
      }
    } catch (error) {
      if (manualStopRequestedRef.current || isAbortError(error)) {
        await manualStopRequestRef.current;
        finalizeStoppedManualMessage(pendingMessage.id);
        setManualFeedback('已停止本次上下文模型对话。');
        setManualFeedbackError(false);
        return;
      }

      setManualMessages((previous) =>
        previous.map((item) =>
          item.id === pendingMessage.id
            ? {
                ...item,
                content: getThrownMessage(error),
                pending: false,
              }
            : item,
        ),
      );
    } finally {
      if (manualAbortControllerRef.current === streamController) {
        manualAbortControllerRef.current = null;
      }
      manualActiveSessionIdRef.current = '';
      manualStopRequestedRef.current = false;
      manualStopRequestRef.current = null;
      setIsManualSending(false);
    }
  }

  async function handleRestoreRevision(revisionId: string) {
    if (!sessionId || !revisionId || isRestoreLocked) {
      return;
    }

    setIsRestoreBusy(true);
    setRestoreError('');

    try {
      const response = await restoreContextRevisionRequest({
        session_id: sessionId,
        revision_id: revisionId,
      });
      onHistoryChange(sessionId, response.history || []);
      onConversationChange(sessionId, normalizeConversation(response.conversation));
      onRevisionHistoryChange(sessionId, response.revisions || []);
      onPendingRestoreChange(sessionId, response.pending_restore || null);
      setManualMessages(buildManualMessagesFromHistory(response.history || []));
    } catch (error) {
      setRestoreError(getThrownMessage(error));
    } finally {
      setIsRestoreBusy(false);
    }
  }

  function handleManualDraftChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setManualDraft(event.target.value);
  }

  function handleManualDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSendManualMessage();
    }
  }

  async function handleCopyManualMessage(content: string) {
    try {
      await copyText(content);
      setManualFeedback('');
      setManualFeedbackError(false);
    } catch (error) {
      setManualFeedback(getThrownMessage(error));
      setManualFeedbackError(true);
    }
  }

  async function handleDeleteManualMessage(messageIndex: number) {
    if (!sessionId || isWorkbenchBusy) {
      return;
    }

    const targetMessage = manualMessages[messageIndex];
    if (!targetMessage || targetMessage.pending) {
      return;
    }

    try {
      const response = await deleteContextWorkbenchMessageRequest({
        session_id: sessionId,
        message_index: messageIndex,
      });
      onHistoryChange(sessionId, response.history || []);
      onConversationChange(sessionId, normalizeConversation(response.conversation));
      onRevisionHistoryChange(sessionId, response.revisions || []);
      onPendingRestoreChange(sessionId, response.pending_restore || null);
      setManualMessages(buildManualMessagesFromHistory(response.history || []));
      setManualFeedback('');
      setManualFeedbackError(false);
    } catch (error) {
      setManualFeedback(getThrownMessage(error));
      setManualFeedbackError(true);
    }
  }

  async function handleClearManualHistory() {
    if (!sessionId || isManualComposerLocked || !hasClearableManualHistory) {
      return;
    }

    try {
      const response = await clearContextWorkbenchHistoryRequest({
        session_id: sessionId,
      });
      onHistoryChange(sessionId, response.history || []);
      onConversationChange(sessionId, normalizeConversation(response.conversation));
      onRevisionHistoryChange(sessionId, response.revisions || []);
      onPendingRestoreChange(sessionId, response.pending_restore || null);
      setManualMessages(buildManualMessagesFromHistory(response.history || []));
      setManualFeedback('');
      setManualFeedbackError(false);
    } catch (error) {
      setManualFeedback(getThrownMessage(error));
      setManualFeedbackError(true);
    }
  }

  return (
    <>
      <div className="extended-header">
        {WORKBENCH_TABS.map((tab) => (
          <button
            aria-pressed={activeTab === tab.id}
            className={`extended-tab ${activeTab === tab.id ? 'active' : ''}`}
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            <i className={`ph-light ${tab.icon}`} />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="extended-content">
        <div
          className="extended-track"
          style={{
            transform: `translateX(-${WORKBENCH_TABS.findIndex((tab) => tab.id === activeTab) * 100}%)`,
          }}
        >
          <section className="extended-page" data-page="suggestions">
            <div className="extended-page-scroll">
              <div className="workbench-panel-title">Token 概览</div>
              <div className="workbench-panel-desc">
                这里是token 统计，你可以直观看到token情况，再决定要不要去手动页处理。
              </div>

              <div className="suggestion-card-grid">
                <div className="suggestion-card">
                  <div className="suggestion-card-label">总 Token 数</div>
                  <div className="suggestion-card-value">{formatTokenCount(localSuggestionStats.total_token_count)}</div>
                  <div className="suggestion-card-note">
                    这里和左侧上下文地图使用同一个 token 计数器，统计当前地图里的节点内容。
                  </div>
                </div>
                <div className="suggestion-card">
                  <div className="suggestion-card-label">工具调用 Token</div>
                  <div className="suggestion-card-value">{formatTokenCount(localSuggestionStats.tool_token_count)}</div>
                  <div className="suggestion-card-note">
                    这里按同一套计数器统计工具展示内容和工具输出占用的 token。
                  </div>
                </div>
                <div className="suggestion-card">
                  <div className="suggestion-card-label">当前聚焦</div>
                  <div className="suggestion-card-value">{selectedNodeNumbers.length || '全部'}</div>
                  <div className="suggestion-card-note">
                    {selectedNodeReferenceSegments.length
                      ? `手动页会优先围绕节点 #${selectedNodeReferenceSegments.join(' / ')} 来看。`
                      : '当前没有单独选中节点，所以手动页会基于整份上下文来处理。'}
                  </div>
                </div>
              </div>

              {suggestionsError ? <div className="workbench-setting-feedback error">{suggestionsError}</div> : null}

              <div className="suggestion-stack">
                <div className="workbench-setting-card">
                  <div className="workbench-setting-title">节点 Token 明细</div>
                  <div className="workbench-setting-desc">
                    这里只显示 minimap 里的红色节点。
                  </div>

                  {isSuggestionsLoading && !localSuggestionNodes.length ? (
                    <div className="suggestion-row">
                      <div className="suggestion-row-title">正在统计 Token...</div>
                      <div className="suggestion-row-body">
                        这一步会把主聊天当前真正会发给模型的上下文一起算进去。
                      </div>
                    </div>
                  ) : criticalSuggestionNodes.length ? (
                    criticalSuggestionNodes.map((node) => (
                      <div className="suggestion-row" key={node.node_index}>
                        <div className="suggestion-row-copy">
                          <div className="suggestion-row-title">节点 #{node.node_number}</div>
                          <div className="restore-revision-meta">
                            {formatSuggestionRoleLabel(node.role)} · {formatTokenCount(node.token_count)} Token
                            {node.tool_token_count > 0
                              ? ` · 工具调用 ${formatTokenCount(node.tool_token_count)} Token`
                              : ''}
                          </div>
                        </div>
                      </div>
                    ))
                  ) : localSuggestionNodes.length ? (
                    <div className="suggestion-row">
                      <div className="suggestion-row-title">当前没有红色节点</div>
                    </div>
                  ) : (
                    <div className="suggestion-row">
                      <div className="suggestion-row-title">当前还没有可统计的节点</div>
                      <div className="suggestion-row-body">
                        等主聊天里有实际上下文之后，这里就会列出每个节点的 Token 数。
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="extended-page" data-page="manual">
            <div className="manual-workbench">
              <div className="manual-workbench-list" ref={manualListRef}>
                {manualMessages.length ? (
                  manualMessages.map((entry, messageIndex) => (
                    <div className={`manual-workbench-message ${entry.role}`} key={entry.id}>
                      <div className="manual-workbench-message-shell">
                        <div className="manual-workbench-bubble">
                        {entry.pending && !entry.content.trim() ? (
                          <div className="thinking-inline-line" role="status">
                            <span className="thinking-inline-text">正在思考...</span>
                          </div>
                        ) : entry.role === 'assistant' ? (
                          <MarkdownRenderer content={entry.content} />
                        ) : (
                          <div className="manual-workbench-user-text">{entry.content}</div>
                        )}
                        </div>
                        {!entry.pending ? (
                          <div className="manual-workbench-actions">
                            <button
                              className="action-btn"
                              type="button"
                              onClick={() => {
                                void handleCopyManualMessage(entry.content);
                              }}
                            >
                              <i className="ph-light ph-copy" />
                            </button>
                            <button
                              className="action-btn"
                              disabled={!sessionId || isWorkbenchBusy}
                              type="button"
                              onClick={() => {
                                void handleDeleteManualMessage(messageIndex);
                              }}
                            >
                              <i className="ph-light ph-trash" />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="manual-workbench-empty">
                    <div className="manual-workbench-empty-title">可以直接整理当前上下文</div>
                    <div className="manual-workbench-empty-body">
                      支持删除或压缩单节点、多节点、文本和工具调用结果；不确定能做什么，就直接问模型有哪些可用功能。
                    </div>
                  </div>
                )}
              </div>

              <div className="manual-workbench-composer">
                <div className="manual-workbench-composer-shell">
                  {isMainChatBusy ? (
                    <div className="workbench-setting-feedback">
                      主聊天这一轮还没结束，右侧上下文工作区会等它先停下来。
                    </div>
                  ) : null}

                  {manualFeedback ? (
                    <div className={`workbench-setting-feedback${manualFeedbackError ? ' error' : ''}`}>
                      {manualFeedback}
                    </div>
                  ) : null}

                  {selectedNodeReferenceSegments.length ? (
                    <div className="manual-workbench-reference-strip">
                      {selectedNodeReferenceSegments.map((segment) => (
                        <span className="manual-workbench-reference-chip" key={segment}>
                          节点 #{segment}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className="manual-workbench-toolbar">
                    <Dropdown
                      align="left"
                      buttonClassName="tool-btn-capsule manual-workbench-reasoning"
                      buttonChildren={
                        <>
                          <i className="ph-light ph-brain" />
                          <span>思考：{currentManualReasoningLabel}</span>
                          <i className="ph-light ph-caret-down" />
                        </>
                      }
                      disabled={manualReasoningDisabled}
                      isOpen={isManualReasoningOpen}
                      onToggle={(event) => {
                        event.stopPropagation();
                        setIsManualReasoningOpen((previous) => !previous);
                      }}
                    >
                      {reasoningOptions.map((option) => (
                        <div
                          className={`dropdown-item ${option.value === manualReasoning ? 'selected' : ''}`}
                          key={option.value}
                          onMouseDown={(event) => handleManualReasoningSelect(event, option)}
                        >
                          <div className="dropdown-item-left">{option.label}</div>
                          <i className="ph-light ph-check check-icon" />
                        </div>
                      ))}
                    </Dropdown>
                  </div>

                  <div className="manual-workbench-input-row">
                    <textarea
                      className="manual-workbench-input"
                      disabled={isManualComposerLocked}
                      onChange={handleManualDraftChange}
                      onKeyDown={handleManualDraftKeyDown}
                      placeholder={
                        sessionId
                          ? '直接问当前上下文哪里太长，或者哪些内容该保留...'
                          : '先进入一个会话，再在这里聊天...'
                      }
                      ref={manualTextareaRef}
                      rows={1}
                      value={manualDraft}
                    />
                    <button
                      aria-label="清空上下文模型对话记录"
                      className="manual-workbench-clear"
                      disabled={!sessionId || isManualComposerLocked || !hasClearableManualHistory}
                      title={hasClearableManualHistory ? '清空上下文模型对话记录' : '当前没有可清空的对话记录'}
                      type="button"
                      onClick={() => {
                        void handleClearManualHistory();
                      }}
                    >
                      <i className="ph-light ph-trash" />
                    </button>
                    <button
                      className={`send-btn manual-workbench-send ${isManualSending ? 'is-stop-action' : 'is-send-action'}`}
                      disabled={isManualSending ? false : (!manualDraft.trim() || isManualComposerLocked)}
                      type="button"
                      title={isManualSending ? '停止上下文模型对话' : '发送给上下文模型'}
                      onClick={isManualSending ? handleStopManualMessage : () => {
                        void handleSendManualMessage();
                      }}
                    >
                      <i className={`ph-light ${isManualSending ? 'ph-stop' : 'ph-arrow-up'}`} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="extended-page" data-page="restore">
            <div className="extended-page-scroll">
              <div className="workbench-panel-title">恢复记录</div>
              <div className="workbench-panel-desc">
                这里保留的是每次提交后的完整版本。一个版本不会只记提交瞬间，它会继续吸收后面的主聊天和上下文聊天，直到下一次提交生成新版本，才会冻结成历史版本。
              </div>

              {restoreError ? <div className="workbench-setting-feedback error">{restoreError}</div> : null}

              <div className="restore-revision-list">
                {revisions.length ? (
                  revisions.map((revision) => (
                    <div className="workbench-setting-card restore-revision-card" key={revision.id}>
                      <div className="restore-revision-head">
                        <div>
                          <div className="restore-revision-title">
                            {revision.revision_number === 0
                              ? (revision.label || '初始版本')
                              : formatChangeTypeLabel(revision.change_type || 'update')}
                          </div>
                          <div className="restore-revision-meta">{formatRevisionMeta(revision)}</div>
                          {revision.is_active ? (
                            <div className="restore-revision-badges">
                              <span className="restore-revision-badge active">当前版本</span>
                            </div>
                          ) : null}
                          <div className="restore-revision-summary">
                            {revision.summary || revision.label || '这次更新了当前上下文。'}
                          </div>
                        </div>

                        {revision.is_active ? (
                          <div className="restore-revision-actions">
                            <div className="restore-revision-status">当前所在版本</div>
                          </div>
                        ) : (
                          <button
                            className="restore-revision-action"
                            disabled={!sessionId || isRestoreLocked}
                            type="button"
                            onClick={() => {
                              void handleRestoreRevision(revision.id);
                            }}
                          >
                            {isRestoreBusy ? '处理中...' : buildRestoreActionLabel(revision)}
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="workbench-setting-card">
                    <div className="workbench-setting-title">还没有恢复记录</div>
                    <div className="workbench-setting-desc">
                      等工作区第一次真正提交上下文改动后，这里就会开始出现版本记录。
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="extended-page" data-page="settings">
            <div className="extended-page-scroll">
              <div className="workbench-panel-title">工作区设置</div>

              <div className="workbench-setting-card">
                <div className="workbench-setting-title">手动页模型</div>
                <div className="workbench-setting-desc">
                  右侧手动页会固定走这个模型，用来做上下文分析和编辑。
                </div>

                <div className="workbench-setting-control-row">
                  <button
                    className="tool-btn-capsule chat-model-picker-trigger workbench-model-picker-trigger"
                    disabled={isSettingsLoading}
                    type="button"
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => {
                      if (event.button !== 0) {
                        return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      setIsModelPickerOpen(true);
                      setSettingsMessage('');
                      setSettingsError('');
                    }}
                  >
                    <span>{workbenchModelDraft}</span>
                    <i className="ph-light ph-caret-down" />
                  </button>

                  <button
                    className="tool-btn-primary"
                    disabled={isSettingsLoading || isSettingsSaving || !workbenchModelDraft.trim() || !workbenchProviderDraft.trim()}
                    type="button"
                    onClick={() => {
                      void handleSaveWorkbenchSettings();
                    }}
                  >
                    {isSettingsSaving ? '保存中...' : '保存设置'}
                  </button>
                </div>

                <div className="workbench-setting-provider-hint">
                  当前工作区供应商：{workbenchProviderName(selectedWorkbenchProvider)}
                </div>

                {settingsMessage ? <div className="workbench-setting-feedback">{settingsMessage}</div> : null}
                {settingsError ? <div className="workbench-setting-feedback error">{settingsError}</div> : null}
              </div>

              <div className="workbench-setting-card">
                <div className="workbench-setting-title">Token 颜色阈值</div>
                <div className="workbench-setting-desc">设置 minimap 的绿色、黄色、红色分段。</div>

                <div className="workbench-setting-control-row">
                  <label className="workbench-token-threshold-field">
                    <span>黄色阈值</span>
                    <input
                      className="settings-input settings-input-small"
                      disabled={isSettingsLoading || isSettingsSaving}
                      min={0}
                      step={100}
                      type="number"
                      value={tokenWarningThresholdDraft}
                      onChange={(event) => {
                        setTokenWarningThresholdDraft(event.target.value);
                        setSettingsMessage('');
                        setSettingsError('');
                      }}
                    />
                  </label>

                  <label className="workbench-token-threshold-field">
                    <span>红色阈值</span>
                    <input
                      className="settings-input settings-input-small"
                      disabled={isSettingsLoading || isSettingsSaving}
                      min={1}
                      step={100}
                      type="number"
                      value={tokenCriticalThresholdDraft}
                      onChange={(event) => {
                        setTokenCriticalThresholdDraft(event.target.value);
                        setSettingsMessage('');
                        setSettingsError('');
                      }}
                    />
                  </label>

                  <button
                    className="tool-btn-primary"
                    disabled={isSettingsLoading || isSettingsSaving || Boolean(tokenThresholdError)}
                    type="button"
                    onClick={() => {
                      void handleSaveWorkbenchSettings();
                    }}
                  >
                    {isSettingsSaving ? '保存中...' : '保存阈值'}
                  </button>
                </div>

                {tokenThresholdError ? <div className="workbench-setting-feedback error">{tokenThresholdError}</div> : null}
              </div>

              <div className="workbench-setting-card">
                <div className="workbench-setting-title">当前工具能力</div>
                <div className="workbench-setting-desc">
                  这些工具只服务当前上下文，不会去跑主任务。现在已经能做节点级查看，以及 item 级压缩、替换和删除。
                </div>

                <div className="workbench-tool-grid">
                  {toolCatalog.map((tool) => {
                    const localized = localizeToolCatalogItem(tool);
                    return (
                      <div className="workbench-tool-card" key={tool.id}>
                        <div className="workbench-tool-card-head">
                          <span className="workbench-tool-card-title">{localized.label}</span>
                          <span className={`workbench-tool-status ${tool.status}`}>{statusLabel(tool.status)}</span>
                        </div>
                        <div className="workbench-tool-card-desc">{localized.description}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <ChatModelPicker
        activeProviderId={workbenchProviderDraft}
        currentModel={workbenchModelDraft}
        open={isModelPickerOpen}
        providers={availableProviders}
        title="选择工作区模型"
        description="这里选的是右侧上下文工作区自己的模型和供应商，不会跟主聊天模型混在一起。"
        selectedContextLabel="当前工作区"
        onClose={() => setIsModelPickerOpen(false)}
        onSelectModel={(providerId: string, model: ResponseProviderModel) => {
          setWorkbenchProviderDraft(providerId);
          setWorkbenchModelDraft(model.id || model.label || '');
          setSettingsMessage('');
          setSettingsError('');
          setIsModelPickerOpen(false);
        }}
      />
    </>
  );
}
