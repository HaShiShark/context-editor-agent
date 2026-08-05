import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, MouseEvent } from 'react';
import { flushSync } from 'react-dom';

import {
  cancelActiveRequest,
  clearContextWorkbenchHistoryRequest,
  contextReviewRequest,
  deleteContextWorkbenchMessageRequest,
  fetchContextWorkbenchSettings,
  restoreContextRevisionRequest,
  saveContextWorkbenchSettingsRequest,
  sessionUsageRequest,
  streamContextChatRequest,
  undoContextRestoreRequest,
} from '../api';
import {
  DEFAULT_CONTEXT_TOKEN_THRESHOLDS,
  normalizeContextTokenThresholds,
  type ContextTokenThresholds,
} from '../contextTokenWeight';
import type {
  ContextReview,
  ContextRestoreResponse,
  ContextRevisionSummary,
  ContextWorkbenchHistoryEntry,
  ContextWorkbenchToolCatalogItem,
  MessageRecord,
  PendingContextRestore,
  ReasoningOption,
  ResponseProviderDraft,
  ResponseProviderModel,
  ResponseProviderSettings,
  SessionUsageBucket,
  SessionUsageSummary,
} from '../types';
import { copyText, getReasoningLabel, normalizeConversation } from '../utils';
import ChatModelPicker from './ChatModelPicker';
import Dropdown from './Dropdown';
import MarkdownRenderer from './MarkdownRenderer';

type WorkbenchTab = 'suggestions' | 'manual' | 'usage' | 'restore' | 'settings';

interface ManualWorkbenchMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

interface ContextWorkbenchProps {
  messages: MessageRecord[];
  selectedNodeIndexes: number[];
  tokenThresholds: ContextTokenThresholds;
  sessionId: string;
  isMainChatBusy: boolean;
  history: ContextWorkbenchHistoryEntry[];
  revisions: ContextRevisionSummary[];
  pendingRestore: PendingContextRestore | null;
  reasoningOptions: ReasoningOption[];
  onHistoryChange: (sessionId: string, history: ContextWorkbenchHistoryEntry[]) => void;
  onConversationChange: (sessionId: string, conversation: MessageRecord[]) => void;
  onContextInputChange: (sessionId: string, conversation: MessageRecord[]) => void;
  onRevisionHistoryChange: (sessionId: string, revisions: ContextRevisionSummary[]) => void;
  onPendingRestoreChange: (sessionId: string, pendingRestore: PendingContextRestore | null) => void;
  onReviewPreviewStateChange: (active: boolean) => void;
  onEnsureSession: () => Promise<string>;
  onTokenThresholdsChange: (thresholds: ContextTokenThresholds) => void;
}

const DEFAULT_WORKBENCH_MODELS = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.2'];
const DEFAULT_WORKBENCH_PROVIDER_ID = 'openai';

const WORKBENCH_TABS: Array<{
  id: WorkbenchTab;
  label: string;
  icon: string;
}> = [
  { id: 'suggestions', label: '建议', icon: 'ph-lightbulb' },
  { id: 'manual', label: '手动', icon: 'ph-hand-pointing' },
  { id: 'usage', label: '用量', icon: 'ph-chart-bar' },
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

function formatContextReviewDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function contextReviewReductionPercent(review: ContextReview | null) {
  const before = Number(review?.before?.token_count || 0);
  const after = Number(review?.after?.token_count || 0);
  if (before <= 0 || after >= before) {
    return '';
  }
  return `${Math.round(((before - after) / before) * 100)}%`;
}

function emptyUsageBucket(): SessionUsageBucket {
  return {
    request_count: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    non_cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
  };
}

function UsageCard({
  title,
  description,
  bucket,
}: {
  title: string;
  description: string;
  bucket?: SessionUsageBucket;
}) {
  const usage = bucket || emptyUsageBucket();
  return (
    <div className="workbench-setting-card session-usage-card">
      <div className="workbench-setting-title">{title}</div>
      <div className="workbench-setting-desc">{description}</div>
      <div className="session-usage-grid">
        <div><span>请求</span><strong>{usage.request_count}</strong></div>
        <div><span>输入</span><strong>{formatTokenCount(usage.input_tokens)}</strong></div>
        <div><span>缓存输入</span><strong>{formatTokenCount(usage.cached_input_tokens)}</strong></div>
        <div><span>输出</span><strong>{formatTokenCount(usage.output_tokens)}</strong></div>
        <div><span>推理</span><strong>{formatTokenCount(usage.reasoning_tokens)}</strong></div>
        <div><span>总计</span><strong>{formatTokenCount(usage.total_tokens)}</strong></div>
      </div>
    </div>
  );
}

function parseTokenThresholdDraft(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function localizeToolCatalogItem(tool: ContextWorkbenchToolCatalogItem) {
  switch (tool.id) {
    case 'get_nodes':
      return {
        label: '展开节点详情',
        description: '把一个或多个节点展开成完整内容和可编辑条目视图，再决定要不要编辑。',
      };
    case 'write_nodes':
      return {
        label: '批量编辑节点',
        description: '一次完成节点删除、插入、替换或压缩，并返回更新后的工作快照。',
      };
    case 'write_items':
      return {
        label: '编辑节点条目',
        description: '只有节点级编辑无法保留必要结构时，才精确编辑节点内部条目。',
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
  selectedNodeIndexes,
  tokenThresholds,
  sessionId,
  isMainChatBusy,
  history,
  revisions,
  pendingRestore,
  reasoningOptions,
  onHistoryChange,
  onConversationChange,
  onContextInputChange,
  onRevisionHistoryChange,
  onPendingRestoreChange,
  onReviewPreviewStateChange,
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
  const [pendingContextReview, setPendingContextReview] = useState<ContextReview | null>(null);
  const [contextReviewAction, setContextReviewAction] = useState<'generate' | 'preview' | 'apply' | 'discard' | null>(null);
  const [isContextPreviewActive, setIsContextPreviewActive] = useState(false);
  const [isSuggestionsLoading, setIsSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState('');
  const [suggestionsMessage, setSuggestionsMessage] = useState('');
  const [usageSummary, setUsageSummary] = useState<SessionUsageSummary | null>(null);
  const [isUsageLoading, setIsUsageLoading] = useState(false);
  const [usageFeedback, setUsageFeedback] = useState('');
  const [usageFeedbackError, setUsageFeedbackError] = useState(false);
  const [contextReviewAutoEnabled, setContextReviewAutoEnabled] = useState(true);
  const [contextReviewIntervalDraft, setContextReviewIntervalDraft] = useState('10');
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
  const previewOriginalMessagesRef = useRef<{
    sessionId: string;
    reviewId: string;
    messages: MessageRecord[];
  } | null>(null);
  const onContextInputChangeRef = useRef(onContextInputChange);
  const onReviewPreviewStateChangeRef = useRef(onReviewPreviewStateChange);

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
  const manualHistoryKey = useMemo(() => JSON.stringify(history || []), [history]);
  const isWorkbenchBusy = isManualSending || isRestoreBusy || contextReviewAction !== null;
  const isManualComposerLocked = isMainChatBusy || isWorkbenchBusy;
  const manualReasoningDisabled = reasoningOptions.length === 0;
  const isRestoreLocked = isMainChatBusy || isRestoreBusy;
  const hasClearableManualHistory = manualMessages.some((message) => !message.pending);
  const currentManualReasoningLabel = getReasoningLabel(manualReasoning, reasoningOptions);
  const pendingReviewReduction = contextReviewReductionPercent(pendingContextReview);
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
  const parsedContextReviewInterval = Number(contextReviewIntervalDraft);
  const contextReviewIntervalError = contextReviewAutoEnabled && (
    !Number.isInteger(parsedContextReviewInterval)
    || parsedContextReviewInterval < 1
    || parsedContextReviewInterval > 1440
  )
    ? '闲置分钟必须是 1–1440 之间的整数'
    : '';

  useEffect(() => {
    onContextInputChangeRef.current = onContextInputChange;
    onReviewPreviewStateChangeRef.current = onReviewPreviewStateChange;
  }, [onContextInputChange, onReviewPreviewStateChange]);

  useEffect(() => () => {
    const preview = previewOriginalMessagesRef.current;
    if (preview) {
      onContextInputChangeRef.current(preview.sessionId, preview.messages);
      previewOriginalMessagesRef.current = null;
    }
    onReviewPreviewStateChangeRef.current(false);
  }, []);

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
        setContextReviewAutoEnabled(response.settings.context_review_auto_enabled !== false);
        setContextReviewIntervalDraft(String(response.settings.context_review_interval_minutes || 10));
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
    let pollTimer: number | null = null;

    async function loadContextReview(showLoading: boolean) {
      if (!sessionId) {
        setPendingContextReview(null);
        setSuggestionsError('');
        setIsSuggestionsLoading(false);
        return;
      }
      if (showLoading) {
        setIsSuggestionsLoading(true);
      }
      try {
        const response = await contextReviewRequest({ session_id: sessionId, action: 'status' });
        if (!cancelled) {
          const nextReview = response.review || null;
          const preview = previewOriginalMessagesRef.current;
          if (preview && (!nextReview || nextReview.id !== preview.reviewId)) {
            onContextInputChange(preview.sessionId, preview.messages);
            previewOriginalMessagesRef.current = null;
            setIsContextPreviewActive(false);
            onReviewPreviewStateChange(false);
          }
          setPendingContextReview(nextReview);
          setSuggestionsError('');
        }
      } catch (error) {
        if (!cancelled) {
          setSuggestionsError(getThrownMessage(error));
        }
      } finally {
        if (!cancelled && showLoading) {
          setIsSuggestionsLoading(false);
        }
      }
    }

    closeContextReviewPreview(true);
    void loadContextReview(true);
    if (activeTab === 'suggestions' && !isMainChatBusy) {
      pollTimer = window.setInterval(() => void loadContextReview(false), 5000);
    }
    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
      }
    };
  }, [activeTab, isMainChatBusy, sessionId]);

  useEffect(() => {
    let cancelled = false;
    if (activeTab !== 'usage') {
      return () => {
        cancelled = true;
      };
    }
    if (!sessionId) {
      setUsageSummary(null);
      setUsageFeedback('');
      setUsageFeedbackError(false);
      return () => {
        cancelled = true;
      };
    }

    setIsUsageLoading(true);
    setUsageFeedback('');
    setUsageFeedbackError(false);
    void sessionUsageRequest({ session_id: sessionId, action: 'status' })
      .then((response) => {
        if (!cancelled) {
          setUsageSummary(response.summary);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setUsageFeedback(getThrownMessage(error));
          setUsageFeedbackError(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsUsageLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, sessionId]);

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
    if (contextReviewIntervalError) {
      setSettingsMessage('');
      setSettingsError(contextReviewIntervalError);
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
        context_review_auto_enabled: contextReviewAutoEnabled,
        context_review_interval_minutes: parsedContextReviewInterval,
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
      setContextReviewAutoEnabled(response.settings.context_review_auto_enabled !== false);
      setContextReviewIntervalDraft(String(response.settings.context_review_interval_minutes || 10));
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
          if (event.context_input) {
            onContextInputChange(targetSessionId, normalizeConversation(event.context_input));
          }
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

  function applyContextRestoreResponse(response: ContextRestoreResponse) {
    startTransition(() => {
      onHistoryChange(sessionId, response.history || []);
      onConversationChange(sessionId, normalizeConversation(response.conversation));
      if (response.context_input) {
        onContextInputChange(sessionId, normalizeConversation(response.context_input));
      }
      onRevisionHistoryChange(sessionId, response.revisions || []);
      onPendingRestoreChange(sessionId, response.pending_restore || null);
      setManualMessages(buildManualMessagesFromHistory(response.history || []));
    });
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
      applyContextRestoreResponse(response);
    } catch (error) {
      setRestoreError(getThrownMessage(error));
    } finally {
      setIsRestoreBusy(false);
    }
  }

  async function handleUndoContextRestore() {
    if (!sessionId || !pendingRestore?.can_undo || isRestoreLocked) {
      return;
    }

    setIsRestoreBusy(true);
    setRestoreError('');

    try {
      const response = await undoContextRestoreRequest({ session_id: sessionId });
      applyContextRestoreResponse(response);
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
      if (response.context_input) {
        onContextInputChange(sessionId, normalizeConversation(response.context_input));
      }
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
      if (response.context_input) {
        onContextInputChange(sessionId, normalizeConversation(response.context_input));
      }
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

  function closeContextReviewPreview(restoreLiveContext = true) {
    const preview = previewOriginalMessagesRef.current;
    if (restoreLiveContext && preview) {
      onContextInputChange(preview.sessionId, preview.messages);
    }
    previewOriginalMessagesRef.current = null;
    setIsContextPreviewActive(false);
    onReviewPreviewStateChange(false);
  }

  async function handleGenerateContextReview() {
    if (!sessionId || isMainChatBusy || contextReviewAction !== null) {
      return;
    }
    setContextReviewAction('generate');
    setSuggestionsError('');
    setSuggestionsMessage('');
    try {
      const response = await contextReviewRequest({ session_id: sessionId, action: 'generate' });
      setPendingContextReview(response.review || null);
      if (!response.review) {
        setSuggestionsMessage('当前没有足够明确且安全的整理收益，正式上下文保持不变。');
      }
    } catch (error) {
      setSuggestionsError(getThrownMessage(error));
    } finally {
      setContextReviewAction(null);
    }
  }

  function handlePreviewContextReview() {
    if (!pendingContextReview || contextReviewAction !== null || isContextPreviewActive) {
      return;
    }
    previewOriginalMessagesRef.current = {
      sessionId,
      reviewId: pendingContextReview.id,
      messages: normalizeConversation(messages),
    };
    onContextInputChange(sessionId, normalizeConversation(pendingContextReview.proposed_transcript));
    setIsContextPreviewActive(true);
    onReviewPreviewStateChange(true);
    setSuggestionsError('');
    setSuggestionsMessage('左侧上下文地图正在显示建议版本；正式上下文尚未改变。');
  }

  async function handleApplyContextReview() {
    if (!pendingContextReview || isMainChatBusy || contextReviewAction !== null) {
      return;
    }
    if (!window.confirm('应用这条建议并生成一个可恢复的新版本吗？')) {
      return;
    }
    setContextReviewAction('apply');
    setSuggestionsError('');
    setSuggestionsMessage('');
    try {
      const response = await contextReviewRequest({
        session_id: sessionId,
        action: 'apply',
        review_id: pendingContextReview.id,
      });
      closeContextReviewPreview(false);
      setPendingContextReview(null);
      if (response.history) {
        onHistoryChange(sessionId, response.history);
        setManualMessages(buildManualMessagesFromHistory(response.history));
      }
      if (response.conversation) {
        onConversationChange(sessionId, normalizeConversation(response.conversation));
      }
      if (response.context_input) {
        onContextInputChange(sessionId, normalizeConversation(response.context_input));
      }
      if (response.revisions) {
        onRevisionHistoryChange(sessionId, response.revisions);
      }
      onPendingRestoreChange(sessionId, response.pending_restore || null);
      setSuggestionsMessage('建议已应用，并已写入恢复页的新版本。');
    } catch (error) {
      setSuggestionsError(getThrownMessage(error));
      try {
        const status = await contextReviewRequest({ session_id: sessionId, action: 'status' });
        setPendingContextReview(status.review || null);
        if (!status.review) {
          closeContextReviewPreview(true);
        }
      } catch {
        // Preserve the current preview when the status cannot be confirmed.
      }
    } finally {
      setContextReviewAction(null);
    }
  }

  async function handleDiscardContextReview() {
    if (!pendingContextReview || contextReviewAction !== null) {
      return;
    }
    setContextReviewAction('discard');
    setSuggestionsError('');
    setSuggestionsMessage('');
    closeContextReviewPreview(true);
    try {
      await contextReviewRequest({
        session_id: sessionId,
        action: 'discard',
        review_id: pendingContextReview.id,
      });
      setPendingContextReview(null);
    } catch (error) {
      setSuggestionsError(getThrownMessage(error));
    } finally {
      setContextReviewAction(null);
    }
  }

  async function handleRefreshUsage() {
    if (!sessionId || isUsageLoading) {
      return;
    }
    setIsUsageLoading(true);
    setUsageFeedback('');
    setUsageFeedbackError(false);
    try {
      const response = await sessionUsageRequest({ session_id: sessionId, action: 'status' });
      setUsageSummary(response.summary);
    } catch (error) {
      setUsageFeedback(getThrownMessage(error));
      setUsageFeedbackError(true);
    } finally {
      setIsUsageLoading(false);
    }
  }

  async function handleResetUsage() {
    if (!sessionId || isUsageLoading) {
      return;
    }
    if (!window.confirm('清空这个会话已经累计的 Provider 用量吗？')) {
      return;
    }
    setIsUsageLoading(true);
    setUsageFeedback('');
    setUsageFeedbackError(false);
    try {
      const response = await sessionUsageRequest({ session_id: sessionId, action: 'reset' });
      setUsageSummary(response.summary);
      setUsageFeedback('这个会话的用量计数已清空。');
    } catch (error) {
      setUsageFeedback(getThrownMessage(error));
      setUsageFeedbackError(true);
    } finally {
      setIsUsageLoading(false);
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
              <div className="workbench-panel-title">上下文建议</div>
              <div className="workbench-panel-desc">
                上下文模型先生成待审核草稿。预览和丢弃不会改正式上下文，明确应用后才会生成可恢复版本。
              </div>

              {suggestionsError ? <div className="workbench-setting-feedback error">{suggestionsError}</div> : null}
              {suggestionsMessage ? <div className="workbench-setting-feedback">{suggestionsMessage}</div> : null}

              {pendingContextReview ? (
                <div className="context-review-card workbench-setting-card">
                  <div className="context-review-card-header">
                    <div>
                      <div className="workbench-setting-title">待审核整理建议</div>
                      <div className="workbench-setting-desc">
                        {formatContextReviewDate(pendingContextReview.created_at)
                          ? `生成时间：${formatContextReviewDate(pendingContextReview.created_at)}`
                          : '由上下文模型生成'}
                      </div>
                    </div>
                    <span className="context-review-status">
                      {pendingContextReview.source === 'auto_idle' ? '自动' : '手动'}
                    </span>
                  </div>

                  <div className="context-review-summary">{pendingContextReview.summary}</div>

                  <div className="context-review-stats" aria-label="建议变化统计">
                    <div className="context-review-stat">
                      <div className="suggestion-card-label">整理前</div>
                      <div className="suggestion-card-value">{pendingContextReview.before.node_count}</div>
                      <div className="suggestion-card-note">
                        {formatTokenCount(pendingContextReview.before.token_count)} Tokens
                      </div>
                    </div>
                    <div className="context-review-stat">
                      <div className="suggestion-card-label">整理后</div>
                      <div className="suggestion-card-value">{pendingContextReview.after.node_count}</div>
                      <div className="suggestion-card-note">
                        {formatTokenCount(pendingContextReview.after.token_count)} Tokens
                      </div>
                    </div>
                    <div className="context-review-stat">
                      <div className="suggestion-card-label">预计减少</div>
                      <div className="suggestion-card-value">{pendingReviewReduction || '-'}</div>
                      <div className="suggestion-card-note">基于当前上下文估算</div>
                    </div>
                  </div>

                  <div className="context-review-actions">
                    <button
                      className="tool-btn-capsule"
                      disabled={contextReviewAction !== null}
                      type="button"
                      onClick={isContextPreviewActive ? () => closeContextReviewPreview(true) : handlePreviewContextReview}
                    >
                      {isContextPreviewActive ? '关闭预览' : '预览'}
                    </button>
                    <button
                      className="tool-btn-primary"
                      disabled={contextReviewAction !== null || isMainChatBusy}
                      type="button"
                      onClick={() => void handleApplyContextReview()}
                    >
                      {contextReviewAction === 'apply' ? '应用中...' : '应用并保存版本'}
                    </button>
                    <button
                      className="tool-btn-capsule"
                      disabled={contextReviewAction !== null}
                      type="button"
                      onClick={() => void handleDiscardContextReview()}
                    >
                      {contextReviewAction === 'discard' ? '丢弃中...' : '丢弃'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="context-review-empty workbench-setting-card">
                  <div className="workbench-setting-title">
                    {isSuggestionsLoading ? '正在读取建议...' : '暂无待审核建议'}
                  </div>
                  <div className="workbench-setting-desc">
                    主聊天结束并达到设置的闲置时间后会自动分析。你也可以现在手动分析当前上下文。
                  </div>
                  <div className="context-review-actions">
                    <button
                      className="tool-btn-primary"
                      disabled={contextReviewAction !== null || isMainChatBusy || !sessionId || isSuggestionsLoading}
                      type="button"
                      onClick={() => void handleGenerateContextReview()}
                    >
                      {contextReviewAction === 'generate' ? '分析中...' : '立即分析'}
                    </button>
                  </div>
                </div>
              )}
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

          <section className="extended-page" data-page="usage">
            <div className="extended-page-scroll">
              <div className="workbench-panel-title">会话用量</div>
              <div className="workbench-panel-desc">
                直接累计 HashCode 各模型 Provider 返回的真实 Token 用量，并区分主 Agent 与上下文模型。Provider 没有返回 usage 的请求不会被猜测补齐。
              </div>

              <div className="context-review-actions usage-actions-row">
                <button
                  className="tool-btn-capsule"
                  disabled={!sessionId || isUsageLoading}
                  type="button"
                  onClick={() => void handleRefreshUsage()}
                >
                  {isUsageLoading ? '读取中...' : '刷新'}
                </button>
                <button
                  className="tool-btn-capsule"
                  disabled={!sessionId || isUsageLoading || !usageSummary?.request_count}
                  type="button"
                  onClick={() => void handleResetUsage()}
                >
                  清空计数
                </button>
                {usageSummary?.latest_at ? (
                  <span className="session-usage-updated">
                    最近记录：{formatContextReviewDate(usageSummary.latest_at)}
                  </span>
                ) : null}
              </div>

              {usageFeedback ? (
                <div className={`workbench-setting-feedback${usageFeedbackError ? ' error' : ''}`}>
                  {usageFeedback}
                </div>
              ) : null}

              <div className="session-usage-stack">
                <UsageCard
                  bucket={usageSummary || undefined}
                  description="当前会话中所有已上报 usage 的模型请求。"
                  title="总用量"
                />
                <UsageCard
                  bucket={usageSummary?.by_kind?.main}
                  description="正常主聊天与工具回合的模型消耗。"
                  title="主 Agent"
                />
                <UsageCard
                  bucket={usageSummary?.by_kind?.context_workbench}
                  description="手动整理、立即分析和闲置自动建议的模型消耗。"
                  title="上下文模型"
                />
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

              {pendingRestore?.can_undo ? (
                <div className="workbench-setting-card restore-revision-card restore-undo-card">
                  <div className="restore-revision-head">
                    <div>
                      <div className="restore-revision-title">已切换到 {pendingRestore.target_label}</div>
                      <div className="restore-revision-summary">
                        这次恢复还可以撤销，撤销后会回到恢复操作前的完整上下文。
                      </div>
                    </div>
                    <button
                      className="restore-revision-action"
                      disabled={isRestoreLocked}
                      type="button"
                      onClick={() => {
                        void handleUndoContextRestore();
                      }}
                    >
                      {isRestoreBusy ? '处理中...' : '撤销这次恢复'}
                    </button>
                  </div>
                </div>
              ) : null}

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
                <div className="workbench-setting-title">自动生成上下文建议</div>
                <div className="workbench-setting-desc">
                  主聊天结束并持续闲置后生成一条待审核提案；不会在后台直接修改正式上下文。
                </div>

                <div className="workbench-setting-control-row">
                  <button
                    aria-checked={contextReviewAutoEnabled}
                    aria-label="自动生成上下文建议"
                    className={`context-review-setting-switch${contextReviewAutoEnabled ? ' is-on' : ''}`}
                    disabled={isSettingsLoading || isSettingsSaving}
                    role="switch"
                    type="button"
                    onClick={() => {
                      setContextReviewAutoEnabled((previous) => !previous);
                      setSettingsMessage('');
                      setSettingsError('');
                    }}
                  >
                    <span />
                  </button>

                  {contextReviewAutoEnabled ? (
                    <label className="workbench-token-threshold-field">
                      <span>闲置分钟</span>
                      <input
                        className="settings-input settings-input-small"
                        disabled={isSettingsLoading || isSettingsSaving}
                        max={1440}
                        min={1}
                        type="number"
                        value={contextReviewIntervalDraft}
                        onChange={(event) => {
                          setContextReviewIntervalDraft(event.target.value);
                          setSettingsMessage('');
                          setSettingsError('');
                        }}
                      />
                    </label>
                  ) : null}

                  <button
                    className="tool-btn-primary"
                    disabled={isSettingsLoading || isSettingsSaving}
                    type="button"
                    onClick={() => void handleSaveWorkbenchSettings()}
                  >
                    {isSettingsSaving ? '保存中...' : '保存自动建议'}
                  </button>
                </div>
                {contextReviewIntervalError ? (
                  <div className="workbench-setting-feedback error">{contextReviewIntervalError}</div>
                ) : null}
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
                  工具只服务当前上下文：先按需读取，再优先批量编辑节点；只有确有必要时才进入 item 级修改。
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
