import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import './ContextMapSidebar.polish.css';
import MessageContent, { getMessagePreviewText } from './MessageContent';
import ContextWorkbench from './ContextWorkbench';
import type {
  ContextWorkbenchHistoryEntry,
  ContextRevisionSummary,
  MessageRecord,
  PendingContextRestore,
  ReasoningOption,
} from '../types';
import {
  countContextMessageTokens,
  countContextToolTokens,
  DEFAULT_CONTEXT_TOKEN_THRESHOLDS,
  getContextTokenWeightClass,
  type ContextTokenThresholds,
  type ContextMessageTokenStat,
  type ContextTokenWeightClass,
} from '../contextTokenWeight';

interface ContextMapSidebarProps {
  stage: 0 | 1 | 2;
  messages: MessageRecord[];
  onToggle: () => void;
  onJumpToMessage: (messageIndex: number) => void;
  sessionId: string;
  isMainChatBusy: boolean;
  contextWorkbenchHistory: ContextWorkbenchHistoryEntry[];
  contextRevisionHistory: ContextRevisionSummary[];
  pendingContextRestore: PendingContextRestore | null;
  reasoningOptions: ReasoningOption[];
  onContextWorkbenchHistoryChange: (sessionId: string, history: ContextWorkbenchHistoryEntry[]) => void;
  onContextWorkbenchConversationChange: (sessionId: string, conversation: MessageRecord[]) => void;
  onContextInputChange: (sessionId: string, conversation: MessageRecord[]) => void;
  onContextRevisionHistoryChange: (sessionId: string, revisions: ContextRevisionSummary[]) => void;
  onPendingContextRestoreChange: (sessionId: string, pendingRestore: PendingContextRestore | null) => void;
  onEnsureSession: () => Promise<string>;
}

interface NodeLayout {
  top: number;
  height: number;
}

interface MinimapBarLayout {
  topPx: number;
  heightPx: number;
}

interface MessageStat extends ContextMessageTokenStat {
  label: string;
  previewText: string;
}

type MessageStatBase = Omit<MessageStat, 'weightClass'>;

interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

const DEFAULT_SCROLL_METRICS: ScrollMetrics = {
  clientHeight: 1,
  scrollHeight: 1,
  scrollTop: 0,
};

const MINIMAP_CONTENT_PADDING_PX = 14;
const MINIMAP_BAR_GAP_PX = 8;
const MINIMAP_VIEWPORT_MIN_HEIGHT_PX = 56;
const MINIMAP_VIEWPORT_KEEP_OFFSET_PX = 14;
const VIRTUAL_NODE_ROW_STRIDE_PX = 64;
const VIRTUAL_NODE_OVERSCAN = 14;
const VIRTUAL_NODE_MIN_COUNT = 80;
const SELECTION_DRAG_THRESHOLD_PX = 4;
const SELECTION_AUTO_SCROLL_EDGE_PX = 68;
const SELECTION_AUTO_SCROLL_MAX_SPEED_PX = 14;

function normalizePlainText(value: string) {
  return value.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

function areScrollMetricsEqual(left: ScrollMetrics, right: ScrollMetrics) {
  return left.clientHeight === right.clientHeight &&
    left.scrollHeight === right.scrollHeight &&
    left.scrollTop === right.scrollTop;
}

function areNodeLayoutsEqual(left: NodeLayout[], right: NodeLayout[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((layout, index) => {
    const nextLayout = right[index];
    return layout.top === nextLayout.top && layout.height === nextLayout.height;
  });
}

function getMinimapBarHeightPx(role: MessageRecord['role'], weightClass: ContextTokenWeightClass) {
  if (role === 'user' || role === 'developer' || role === 'system' || role === 'compaction' || role === 'context') {
    return 4;
  }

  if (weightClass === 'heavy') {
    return 7;
  }

  if (weightClass === 'medium') {
    return 6;
  }

  return 5;
}

function getContextNodeRoleName(role: MessageRecord['role']) {
  return role;
}

function getContextNodeClassName(role: MessageRecord['role']) {
  return role;
}

function isEditableContextNode(role: MessageRecord['role']) {
  return role === 'user' || role === 'assistant';
}

function buildRangeSelection(
  startIndex: number,
  endIndex: number,
  baseSelection: Set<number>,
  mode: 'replace' | 'add',
  selectableIndexes: Set<number>,
) {
  const next = mode === 'add'
    ? new Set([...baseSelection].filter((index) => selectableIndexes.has(index)))
    : new Set<number>();
  const rangeStart = Math.min(startIndex, endIndex);
  const rangeEnd = Math.max(startIndex, endIndex);

  for (let index = rangeStart; index <= rangeEnd; index += 1) {
    if (selectableIndexes.has(index)) {
      next.add(index);
    }
  }

  return next;
}

function canExpandMessage(record: MessageRecord, previewText: string) {
  if (record.attachments.length > 0 || record.toolEvents.length > 0) {
    return true;
  }

  const hasMultipleBlocks = record.blocks.length > 1;
  const textValue = record.text || '';
  const normalizedText = normalizePlainText(textValue);
  const normalizedPreview = normalizePlainText(previewText);
  const hasLineBreaks = /\r?\n/.test(textValue);
  const hasMarkdownSyntax = /[#>*_\-`[\]()|]/.test(textValue);
  const isLongPlainText = normalizedText.length > 96;

  if (record.role === 'assistant') {
    return Boolean(normalizedText || hasMultipleBlocks);
  }

  return hasMultipleBlocks || hasLineBreaks || hasMarkdownSyntax || isLongPlainText || normalizedText !== normalizedPreview;
}

export default function ContextMapSidebar({
  stage,
  messages,
  onToggle,
  onJumpToMessage,
  sessionId,
  isMainChatBusy,
  contextWorkbenchHistory,
  contextRevisionHistory,
  pendingContextRestore,
  reasoningOptions,
  onContextWorkbenchHistoryChange,
  onContextWorkbenchConversationChange,
  onContextInputChange,
  onContextRevisionHistoryChange,
  onPendingContextRestoreChange,
  onEnsureSession,
}: ContextMapSidebarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const minimapScrollRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Array<HTMLDivElement | null>>([]);
  const minimapDragRef = useRef<{
    offsetPx: number;
  } | null>(null);
  const selectionDragRef = useRef<{
    startIndex: number;
    lastIndex: number;
    startClientY: number;
    pointerClientY: number;
    originSelection: Set<number>;
    mode: 'replace' | 'add';
    hasMoved: boolean;
  } | null>(null);
  const selectionAutoScrollFrameRef = useRef<number | null>(null);
  const previousMessageCountRef = useRef(messages.length);
  const [expandedIndexes, setExpandedIndexes] = useState<Set<number>>(new Set());
  const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(new Set());
  const [nodeLayouts, setNodeLayouts] = useState<NodeLayout[]>([]);
  const [scrollMetrics, setScrollMetrics] = useState<ScrollMetrics>(DEFAULT_SCROLL_METRICS);
  const [tokenThresholds, setTokenThresholds] = useState<ContextTokenThresholds>(DEFAULT_CONTEXT_TOKEN_THRESHOLDS);
  const [isContextReviewPreviewActive, setIsContextReviewPreviewActive] = useState(false);
  const [visibleStage, setVisibleStage] = useState<0 | 1 | 2>(0);
  const mountedRef = useRef(false);
  const mountAnimFrameRef = useRef<number | null>(null);

  // animate-in on mount: render as stage-0 first frame, then jump to real stage so CSS transition fires
  useEffect(() => {
    setIsContextReviewPreviewActive(false);
  }, [sessionId]);

  useEffect(() => {
    if (stage === 0) {
      setVisibleStage(0);
      return () => {
        if (mountAnimFrameRef.current !== null) cancelAnimationFrame(mountAnimFrameRef.current);
      };
    }
    if (!mountedRef.current) {
      // Fresh mount — animate from stage-0 to target
      mountedRef.current = true;
      mountAnimFrameRef.current = requestAnimationFrame(() => {
        mountAnimFrameRef.current = requestAnimationFrame(() => {
          setVisibleStage(stage);
        });
      });
      return () => {
        if (mountAnimFrameRef.current !== null) cancelAnimationFrame(mountAnimFrameRef.current);
      };
    }
    // Follow stage changes immediately (1↔2)
    setVisibleStage(stage);
  }, [stage]);

  const effectiveStage = stage === 0 ? 0 : visibleStage;
  const showMinimap = effectiveStage === 2;

  const tokenThresholdsRef = useRef<ContextTokenThresholds>(tokenThresholds);
  tokenThresholdsRef.current = tokenThresholds;

  const setTokenThresholdsSafe = useCallback((nextThresholds: ContextTokenThresholds) => {
    if (
      nextThresholds.warningThreshold === tokenThresholdsRef.current.warningThreshold &&
      nextThresholds.criticalThreshold === tokenThresholdsRef.current.criticalThreshold
    ) {
      return;
    }
    setTokenThresholds(nextThresholds);
  }, []);

  const messageStatBase = useMemo<MessageStatBase[]>(() => {
    let editableNodeCursor = 0;

    return messages.map((message, index) => {
      const tokens = countContextMessageTokens(message);
      const toolTokens = countContextToolTokens(message);
      const roleName = getContextNodeRoleName(message.role);
      const size = (tokens / 1000).toFixed(1);
      const isEditable = isEditableContextNode(message.role);
      const editableNodeIndex = isEditable ? editableNodeCursor : null;
      const editableNodeNumber = editableNodeIndex === null ? null : editableNodeIndex + 1;

      if (isEditable) {
        editableNodeCursor += 1;
      }

      return {
        nodeIndex: index,
        nodeNumber: editableNodeNumber ?? 0,
        editableNodeIndex,
        editableNodeNumber,
        isEditable,
        role: roleName,
        label: `${roleName}: ${size}k`,
        previewText: getMessagePreviewText(message),
        tokens,
        toolTokens,
      };
    });
  }, [messages]);

  const messageStats = useMemo<MessageStat[]>(() => messageStatBase.map((stats) => ({
    ...stats,
    weightClass: getContextTokenWeightClass(stats.tokens, tokenThresholds),
  })), [messageStatBase, tokenThresholds]);
  const editableMessageIndexes = useMemo(
    () => new Set(messageStats.filter((stats) => stats.isEditable).map((stats) => stats.nodeIndex)),
    [messageStats],
  );

  const scrollRange = Math.max(scrollMetrics.scrollHeight - scrollMetrics.clientHeight, 0);
  const scrollRatio = scrollRange <= 0 ? 0 : scrollMetrics.scrollTop / scrollRange;
  let minimapCursorPx = MINIMAP_CONTENT_PADDING_PX;
  const fallbackMinimapBars: MinimapBarLayout[] = messages.map((message, index) => {
    const layout = {
      topPx: minimapCursorPx,
      heightPx: getMinimapBarHeightPx(message.role, messageStats[index]?.weightClass ?? 'light'),
    };

    minimapCursorPx += layout.heightPx;
    if (index < messages.length - 1) {
      minimapCursorPx += MINIMAP_BAR_GAP_PX;
    }

    return layout;
  });
  const minimapContentHeightPx = Math.max(
    minimapCursorPx + MINIMAP_CONTENT_PADDING_PX,
    MINIMAP_CONTENT_PADDING_PX * 2 + MINIMAP_VIEWPORT_MIN_HEIGHT_PX,
  );
  const minimapUsableHeightPx = Math.max(minimapContentHeightPx - MINIMAP_CONTENT_PADDING_PX * 2, 1);
  const minimapViewportHeightPx = Math.min(
    minimapUsableHeightPx,
    Math.max(
      scrollMetrics.scrollHeight <= 0
        ? minimapUsableHeightPx
        : (scrollMetrics.clientHeight / scrollMetrics.scrollHeight) * minimapUsableHeightPx,
      MINIMAP_VIEWPORT_MIN_HEIGHT_PX,
    ),
  );
  const minimapViewportTravelPx = Math.max(minimapUsableHeightPx - minimapViewportHeightPx, 0);
  const minimapViewportTopPx = MINIMAP_CONTENT_PADDING_PX + scrollRatio * minimapViewportTravelPx;
  const effectiveScrollHeight = Math.max(scrollMetrics.scrollHeight, 1);
  const desiredMinimapBars: MinimapBarLayout[] = messages.map((message, index) => {
    const fallbackLayout = fallbackMinimapBars[index];
    const nodeLayout = nodeLayouts[index];
    const heightPx = fallbackLayout?.heightPx ?? getMinimapBarHeightPx(message.role, messageStats[index]?.weightClass ?? 'light');

    if (!nodeLayout || nodeLayout.height <= 0) {
      return fallbackLayout;
    }

    const nodeCenter = nodeLayout.top + nodeLayout.height / 2;
    const centerRatio = Math.min(Math.max(nodeCenter / effectiveScrollHeight, 0), 1);
    const centeredTopPx =
      MINIMAP_CONTENT_PADDING_PX + centerRatio * minimapUsableHeightPx - heightPx / 2;
    const maxTopPx = MINIMAP_CONTENT_PADDING_PX + minimapUsableHeightPx - heightPx;

    return {
      topPx: Math.min(Math.max(centeredTopPx, MINIMAP_CONTENT_PADDING_PX), maxTopPx),
      heightPx,
    };
  });
  const minimapBottomLimitPx = minimapContentHeightPx - MINIMAP_CONTENT_PADDING_PX;
  const minimapBars: MinimapBarLayout[] = [];

  desiredMinimapBars.forEach((layout, index) => {
    const previousBar = index > 0 ? minimapBars[index - 1] : null;
    const minTopPx = previousBar
      ? previousBar.topPx + previousBar.heightPx + MINIMAP_BAR_GAP_PX
      : MINIMAP_CONTENT_PADDING_PX;
    const maxTopPx = minimapBottomLimitPx - layout.heightPx;

    minimapBars.push({
      ...layout,
      topPx: Math.min(Math.max(layout.topPx, minTopPx), maxTopPx),
    });
  });

  for (let index = minimapBars.length - 2; index >= 0; index -= 1) {
    const nextBar = minimapBars[index + 1];
    const currentBar = minimapBars[index];
    const maxTopPx = nextBar.topPx - currentBar.heightPx - MINIMAP_BAR_GAP_PX;

    minimapBars[index] = {
      ...currentBar,
      topPx: Math.max(MINIMAP_CONTENT_PADDING_PX, Math.min(currentBar.topPx, maxTopPx)),
    };
  }

  const shouldVirtualizeList = stage === 2 && expandedIndexes.size === 0 && messages.length > VIRTUAL_NODE_MIN_COUNT;
  const virtualStartIndex = shouldVirtualizeList
    ? Math.max(0, Math.floor(scrollMetrics.scrollTop / VIRTUAL_NODE_ROW_STRIDE_PX) - VIRTUAL_NODE_OVERSCAN)
    : 0;
  const virtualEndIndex = shouldVirtualizeList
    ? Math.min(
        messages.length,
        Math.ceil((scrollMetrics.scrollTop + scrollMetrics.clientHeight) / VIRTUAL_NODE_ROW_STRIDE_PX) + VIRTUAL_NODE_OVERSCAN,
      )
    : messages.length;
  const virtualTopSpacerHeightPx = shouldVirtualizeList ? virtualStartIndex * VIRTUAL_NODE_ROW_STRIDE_PX : 0;
  const virtualBottomSpacerHeightPx = shouldVirtualizeList
    ? Math.max(0, (messages.length - virtualEndIndex) * VIRTUAL_NODE_ROW_STRIDE_PX)
    : 0;
  const visibleMessageEntries = useMemo(
    () => (shouldVirtualizeList
      ? messages.slice(virtualStartIndex, virtualEndIndex).map((message, offset) => ({
          index: virtualStartIndex + offset,
          message,
        }))
      : messages.map((message, index) => ({ index, message }))),
    [messages, shouldVirtualizeList, virtualEndIndex, virtualStartIndex],
  );

  useEffect(() => {
    setExpandedIndexes(new Set());
    setSelectedIndexes(new Set());
  }, [sessionId]);

  useEffect(() => {
    setExpandedIndexes((previous) => {
      const next = new Set<number>();
      previous.forEach((index) => {
        if (index >= 0 && index < messages.length) {
          next.add(index);
        }
      });
      return next;
    });
  }, [messages]);

  useEffect(() => {
    setSelectedIndexes((previous) => {
      const next = new Set<number>();
      previous.forEach((index) => {
        if (index >= 0 && index < messages.length && editableMessageIndexes.has(index)) {
          next.add(index);
        }
      });
      return next;
    });
  }, [editableMessageIndexes, messages]);

  useEffect(() => {
    if (stage === 1) {
      setExpandedIndexes(new Set());
    }
  }, [stage]);

  useEffect(() => {
    const messageCountChanged = previousMessageCountRef.current !== messages.length;
    previousMessageCountRef.current = messages.length;

    if (!messageCountChanged || stage === 0) {
      return;
    }

    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, stage]);

  useEffect(() => {
    if (stage === 0) {
      return;
    }

    function measureNodes() {
      const container = scrollRef.current;
      if (!container) {
        return;
      }

      if (shouldVirtualizeList) {
        const nextMetrics = {
          clientHeight: container.clientHeight || 1,
          scrollHeight: container.scrollHeight || 1,
          scrollTop: container.scrollTop,
        };
        setNodeLayouts((previous) => (previous.length ? [] : previous));
        setScrollMetrics((previous) => (areScrollMetricsEqual(previous, nextMetrics) ? previous : nextMetrics));
        return;
      }

      const nextLayouts = messages.map((_, index) => {
        const node = nodeRefs.current[index];
        if (!node) {
          return { top: 0, height: 0 };
        }

        return {
          top: node.offsetTop,
          height: node.offsetHeight,
        };
      });

      const nextMetrics = {
        clientHeight: container.clientHeight || 1,
        scrollHeight: container.scrollHeight || 1,
        scrollTop: container.scrollTop,
      };

      setNodeLayouts((previous) => (areNodeLayoutsEqual(previous, nextLayouts) ? previous : nextLayouts));
      setScrollMetrics((previous) => (areScrollMetricsEqual(previous, nextMetrics) ? previous : nextMetrics));
    }

    const frameId = window.requestAnimationFrame(measureNodes);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measureNodes()) : null;

    if (scrollRef.current && resizeObserver) {
      resizeObserver.observe(scrollRef.current);
    }

    window.addEventListener('resize', measureNodes);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', measureNodes);
      resizeObserver?.disconnect();
    };
  }, [messages, expandedIndexes, shouldVirtualizeList, stage]);

  useEffect(() => {
    if (stage === 0) {
      return undefined;
    }

    const container = scrollRef.current;
    if (!container) {
      return undefined;
    }
    const activeContainer = container;

    function syncScrollMetrics() {
      const nextMetrics = {
        clientHeight: activeContainer.clientHeight || 1,
        scrollHeight: activeContainer.scrollHeight || 1,
        scrollTop: activeContainer.scrollTop,
      };
      setScrollMetrics((previous) => (areScrollMetricsEqual(previous, nextMetrics) ? previous : nextMetrics));
    }

    syncScrollMetrics();
    activeContainer.addEventListener('scroll', syncScrollMetrics, { passive: true });

    return () => {
      activeContainer.removeEventListener('scroll', syncScrollMetrics);
    };
  }, [messages.length, stage]);

  useEffect(() => {
    if (!showMinimap) {
      return;
    }

    const minimapScroller = minimapScrollRef.current;
    if (!minimapScroller) {
      return;
    }

    const maxScroll = Math.max(minimapContentHeightPx - minimapScroller.clientHeight, 0);
    const desiredScrollTop = Math.min(
      Math.max(minimapViewportTopPx - MINIMAP_VIEWPORT_KEEP_OFFSET_PX, 0),
      maxScroll,
    );

    minimapScroller.scrollTop = desiredScrollTop;
  }, [minimapContentHeightPx, minimapViewportTopPx, showMinimap, messages.length]);

  const handlersRef = useRef<{
    handleWindowMouseMove: (event: MouseEvent) => void;
    handleWindowMouseUp: () => void;
  }>({
    handleWindowMouseMove: () => {},
    handleWindowMouseUp: () => {},
  });

  handlersRef.current = {
    handleWindowMouseMove(event: MouseEvent) {
      syncScrollFromMinimap(event.clientY);
      updateDraggedSelection(event.clientY);
      ensureSelectionAutoScroll();
    },
    handleWindowMouseUp() {
      minimapDragRef.current = null;
      finishSelectionDrag();
    },
  };

  useEffect(() => {
    function handleWindowMouseMove(event: MouseEvent) {
      handlersRef.current.handleWindowMouseMove(event);
    }
    function handleWindowMouseUp() {
      handlersRef.current.handleWindowMouseUp();
    }

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (selectionAutoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionAutoScrollFrameRef.current);
      }
    };
  }, []);

  function toggleMessage(index: number) {
    setExpandedIndexes((previous) => {
      const next = new Set(previous);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function setNodeRef(index: number, node: HTMLDivElement | null) {
    nodeRefs.current[index] = node;
  }

  function getNodeIndexFromClientY(clientY: number) {
    const container = scrollRef.current;
    if (!container) {
      return null;
    }

    const rect = container.getBoundingClientRect();
    const relativeY = clientY - rect.top + container.scrollTop;

    if (shouldVirtualizeList) {
      return Math.min(
        Math.max(Math.floor(relativeY / VIRTUAL_NODE_ROW_STRIDE_PX), 0),
        Math.max(messages.length - 1, 0),
      );
    }

    if (!nodeLayouts.length) {
      return null;
    }

    for (let index = 0; index < nodeLayouts.length; index += 1) {
      const layout = nodeLayouts[index];
      const middleY = layout.top + layout.height / 2;
      if (relativeY < middleY) {
        return index;
      }
    }

    return nodeLayouts.length - 1;
  }

  function stopSelectionAutoScroll() {
    if (selectionAutoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionAutoScrollFrameRef.current);
      selectionAutoScrollFrameRef.current = null;
    }
  }

  function getSelectionAutoScrollDelta(clientY: number) {
    const container = scrollRef.current;
    if (!container) {
      return 0;
    }

    const rect = container.getBoundingClientRect();
    const topDistance = clientY - rect.top;
    const bottomDistance = rect.bottom - clientY;

    if (topDistance < SELECTION_AUTO_SCROLL_EDGE_PX) {
      const progress = (SELECTION_AUTO_SCROLL_EDGE_PX - topDistance) / SELECTION_AUTO_SCROLL_EDGE_PX;
      return -Math.max(1, Math.round(progress * SELECTION_AUTO_SCROLL_MAX_SPEED_PX));
    }

    if (bottomDistance < SELECTION_AUTO_SCROLL_EDGE_PX) {
      const progress = (SELECTION_AUTO_SCROLL_EDGE_PX - bottomDistance) / SELECTION_AUTO_SCROLL_EDGE_PX;
      return Math.max(1, Math.round(progress * SELECTION_AUTO_SCROLL_MAX_SPEED_PX));
    }

    return 0;
  }

  function ensureSelectionAutoScroll() {
    if (!selectionDragRef.current || selectionAutoScrollFrameRef.current !== null) {
      return;
    }

    const tick = () => {
      const dragState = selectionDragRef.current;
      const container = scrollRef.current;

      if (!dragState || !container) {
        selectionAutoScrollFrameRef.current = null;
        return;
      }

      const scrollDelta = getSelectionAutoScrollDelta(dragState.pointerClientY);
      if (scrollDelta === 0) {
        selectionAutoScrollFrameRef.current = null;
        return;
      }

      const nextScrollTop = Math.min(
        Math.max(container.scrollTop + scrollDelta, 0),
        Math.max(container.scrollHeight - container.clientHeight, 0),
      );

      if (nextScrollTop !== container.scrollTop) {
        container.scrollTop = nextScrollTop;
        updateDraggedSelection(dragState.pointerClientY, true);
      }

      selectionAutoScrollFrameRef.current = window.requestAnimationFrame(tick);
    };

    selectionAutoScrollFrameRef.current = window.requestAnimationFrame(tick);
  }

  function updateDraggedSelection(clientY: number, forceActive = false) {
    const dragState = selectionDragRef.current;
    if (!dragState) {
      return;
    }

    dragState.pointerClientY = clientY;

    const targetIndex = getNodeIndexFromClientY(clientY);
    if (targetIndex === null || !editableMessageIndexes.has(targetIndex)) {
      return;
    }

    const crossedThreshold =
      Math.abs(clientY - dragState.startClientY) > SELECTION_DRAG_THRESHOLD_PX || targetIndex !== dragState.startIndex;

    if (!dragState.hasMoved && (forceActive || crossedThreshold)) {
      dragState.hasMoved = true;
    }

    if (!dragState.hasMoved) {
      return;
    }

    if (dragState.lastIndex === targetIndex && !forceActive) {
      return;
    }

    dragState.lastIndex = targetIndex;
    setSelectedIndexes(
      buildRangeSelection(
        dragState.startIndex,
        targetIndex,
        dragState.originSelection,
        dragState.mode,
        editableMessageIndexes,
      ),
    );
  }

  function finishSelectionDrag() {
    const dragState = selectionDragRef.current;
    if (!dragState) {
      stopSelectionAutoScroll();
      return;
    }

    if (!dragState.hasMoved) {
      if (dragState.mode === 'add') {
        const next = new Set(dragState.originSelection);
        if (next.has(dragState.startIndex)) {
          next.delete(dragState.startIndex);
        } else {
          next.add(dragState.startIndex);
        }
        setSelectedIndexes(next);
      } else if (dragState.originSelection.size === 1 && dragState.originSelection.has(dragState.startIndex)) {
        setSelectedIndexes(new Set());
      } else {
        setSelectedIndexes(new Set([dragState.startIndex]));
      }
    } else {
      updateDraggedSelection(dragState.pointerClientY, true);
    }

    selectionDragRef.current = null;
    stopSelectionAutoScroll();
  }

  function handleGutterMouseDown(index: number, event: ReactMouseEvent<HTMLButtonElement>) {
    if (!editableMessageIndexes.has(index)) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const additive = event.metaKey || event.ctrlKey;
    selectionDragRef.current = {
      startIndex: index,
      lastIndex: index,
      startClientY: event.clientY,
      pointerClientY: event.clientY,
      originSelection: new Set(selectedIndexes),
      mode: additive ? 'add' : 'replace',
      hasMoved: false,
    };
  }

  function handleGutterKeyDown(index: number, event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!editableMessageIndexes.has(index)) {
      return;
    }

    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();

    if (event.metaKey || event.ctrlKey) {
      setSelectedIndexes((previous) => {
        const next = new Set(previous);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
      return;
    }

    setSelectedIndexes((previous) => {
      if (previous.size === 1 && previous.has(index)) {
        return new Set();
      }

      return new Set([index]);
    });
  }

  function scrollToNode(index: number) {
    const container = scrollRef.current;
    const layout = nodeLayouts[index];

    if (!container) {
      return;
    }

    if (shouldVirtualizeList && !layout) {
      container.scrollTo({
        top: Math.max(index * VIRTUAL_NODE_ROW_STRIDE_PX - 18, 0),
        behavior: 'smooth',
      });
      return;
    }

    if (!layout) {
      return;
    }

    const nextTop = Math.max(layout.top - 18, 0);
    container.scrollTo({
      top: nextTop,
      behavior: 'smooth',
    });
  }

  function syncScrollFromMinimap(clientY: number) {
    const dragState = minimapDragRef.current;
    const minimap = minimapRef.current;
    const minimapScroller = minimapScrollRef.current;
    const container = scrollRef.current;

    if (!dragState || !minimap || !minimapScroller || !container) {
      return;
    }

    const rect = minimap.getBoundingClientRect();
    const pointerContentY = minimapScroller.scrollTop + clientY - rect.top;
    const rawTop = pointerContentY - dragState.offsetPx;
    const clampedTop = Math.min(
      Math.max(rawTop, MINIMAP_CONTENT_PADDING_PX),
      MINIMAP_CONTENT_PADDING_PX + minimapViewportTravelPx,
    );
    const nextScrollTop =
      minimapViewportTravelPx <= 0
        ? 0
        : ((clampedTop - MINIMAP_CONTENT_PADDING_PX) / minimapViewportTravelPx) *
          Math.max(container.scrollHeight - container.clientHeight, 0);

    container.scrollTop = nextScrollTop;
  }

  function handleMinimapMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    const minimap = minimapRef.current;
    const minimapScroller = minimapScrollRef.current;

    if (!minimap || !minimapScroller) {
      return;
    }

    event.preventDefault();

    const rect = minimap.getBoundingClientRect();
    const pointerContentY = minimapScroller.scrollTop + event.clientY - rect.top;

    const target = event.target as HTMLElement;
    const pressedViewport = target.closest('.context-minimap-viewport');
    const offsetPx = pressedViewport
      ? pointerContentY - minimapViewportTopPx
      : minimapViewportHeightPx / 2;
    minimapDragRef.current = {
      offsetPx,
    };
    syncScrollFromMinimap(event.clientY);
  }

  const selectedNodeIndexes = useMemo(
    () => [...selectedIndexes]
      .sort((left, right) => left - right)
      .map((index) => messageStats[index]?.editableNodeIndex)
      .filter((index): index is number => index !== null && index !== undefined),
    [messageStats, selectedIndexes],
  );
  const criticalNodeIndexes = useMemo(
    () => messageStats
      .map((stats) => (stats.isEditable && stats.weightClass === 'heavy' ? stats.editableNodeIndex : -1))
      .filter((index): index is number => typeof index === 'number' && index >= 0),
    [messageStats],
  );

  return (
    <aside className={`right-panel stage-${effectiveStage}`}>
      <div className="context-map-pane">
        <div className="context-map-header">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="context-map-title">上下文地图</div>
            {(stage === 1 || stage === 2) && (
              <i
                className="ph-light ph-layout control-btn-main active"
                onClick={onToggle}
                title="切换右侧侧边栏"
                style={{ fontSize: '18px', cursor: 'pointer' }}
              />
            )}
          </div>
        </div>

        {isContextReviewPreviewActive ? (
          <div className="context-review-preview-banner" role="status">
            <i className="ph-light ph-eye" />
            <span>建议预览中 · 正式上下文尚未改变</span>
          </div>
        ) : null}

        <div className="context-map-list">
          <div className="context-map-scroll-shell" ref={scrollRef}>
            <div className="context-map-list-inner">
              {messages.length > 0 ? (
                <>
                  {shouldVirtualizeList && virtualTopSpacerHeightPx > 0 ? (
                    <div aria-hidden="true" style={{ flexShrink: 0, height: `${virtualTopSpacerHeightPx}px` }} />
                  ) : null}
                  {visibleMessageEntries.map(({ message, index }) => {
                    const isExpanded = expandedIndexes.has(index);
                    const isSelected = selectedIndexes.has(index);
                    const stats = messageStats[index];
                    const canExpand = canExpandMessage(message, stats.previewText);
                    const canToggleExpand = stage !== 1 && canExpand;
                    const canSelect = stats.isEditable;
                    const canJumpToChat = stage === 1 && canSelect;
                    const isInteractive = canToggleExpand || canJumpToChat;
                    const selectedClass = isSelected ? 'selected' : '';

                    return (
                      <div
                        className={`context-node-row ${getContextNodeClassName(message.role)} ${isExpanded ? 'expanded' : ''} ${selectedClass} ${stage === 1 ? 'without-gutter' : ''}`}
                        key={`${message.role}-${index}`}
                        ref={(node) => setNodeRef(index, node)}
                      >
                      {stage !== 1 && canSelect ? (
                        <button
                          className="context-node-gutter"
                          type="button"
                          onMouseDown={(event) => handleGutterMouseDown(index, event)}
                          onKeyDown={(event) => handleGutterKeyDown(index, event)}
                          aria-label={`选择 Node #${stats.editableNodeNumber ?? ''}`}
                          aria-pressed={isSelected}
                        >
                          <span>{stats.editableNodeNumber}</span>
                        </button>
                      ) : stage !== 1 ? (
                        <div className="context-node-gutter context-node-gutter-readonly" aria-hidden="true">
                          <span />
                        </div>
                      ) : null}

                      <div
                        className={`context-map-item ${getContextNodeClassName(message.role)} ${isExpanded ? 'expanded' : ''} ${selectedClass}`}
                      >
                        <button
                          aria-expanded={canToggleExpand ? isExpanded : undefined}
                          aria-label={canJumpToChat ? `跳转到 Node #${stats.editableNodeNumber ?? ''}` : undefined}
                          className={`context-map-item-button ${isInteractive ? '' : 'non-expandable'}`}
                          type="button"
                          onClick={
                            isInteractive
                              ? () => {
                                  if (canJumpToChat) {
                                    onJumpToMessage(stats.editableNodeIndex ?? index);
                                    return;
                                  }

                                  toggleMessage(index);
                                }
                              : undefined
                          }
                        >
                          <div className="map-metadata">
                            <span>{stats.label}</span>
                            {canToggleExpand ? (
                              <i
                                className={`ph-light ph-caret-right context-map-expand-icon ${isExpanded ? 'open' : ''}`}
                              />
                            ) : null}
                          </div>
                          {!isExpanded ? (
                            <div className="map-bubble">
                              <span className="map-preview-text">{stats.previewText}</span>
                            </div>
                          ) : null}
                        </button>

                        {canToggleExpand && isExpanded ? (
                          <div className="context-map-expanded-shell open">
                            <div className="context-map-expanded-content">
                              <div className="context-map-expanded-body">
                                <MessageContent record={message} variant="context-map" />
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                    );
                  })}
                  {shouldVirtualizeList && virtualBottomSpacerHeightPx > 0 ? (
                    <div aria-hidden="true" style={{ flexShrink: 0, height: `${virtualBottomSpacerHeightPx}px` }} />
                  ) : null}
                </>
              ) : (
                <div style={{ padding: '20px', textAlign: 'center', opacity: 0.4, fontSize: '13px' }}>
                  这里会显示本轮真正进入上下文的消息。
                </div>
              )}
            </div>
          </div>

          {showMinimap ? (
            <div className="context-minimap-shell">
              <div className="context-minimap" role="presentation">
                <div className="context-minimap-track" ref={minimapRef} onMouseDown={handleMinimapMouseDown}>
                  <div className="context-minimap-scroll" ref={minimapScrollRef}>
                    <div className="context-minimap-content" style={{ height: `${minimapContentHeightPx}px` }}>
                      {messages.map((message, index) => {
                        const layout = minimapBars[index];
                        const stats = messageStats[index];

                        return (
                          <button
                            className={`context-minimap-bar ${getContextNodeClassName(message.role)} weight-${stats.weightClass} ${selectedIndexes.has(index) ? 'selected' : ''}`}
                            key={`minimap-${message.role}-${index}`}
                            type="button"
                            style={{
                              top: `${layout?.topPx ?? MINIMAP_CONTENT_PADDING_PX}px`,
                              height: `${layout?.heightPx ?? 4}px`,
                            }}
                            onMouseDown={(event) => {
                              event.stopPropagation();
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              scrollToNode(index);
                            }}
                            aria-label={stats.editableNodeNumber
                              ? `定位到 Node #${stats.editableNodeNumber}，约 ${stats.tokens} 个 token`
                              : `定位到 ${stats.role} 节点，约 ${stats.tokens} 个 token`}
                          />
                        );
                      })}
                      <div
                        className="context-minimap-viewport"
                        style={{
                          top: `${minimapViewportTopPx}px`,
                          height: `${minimapViewportHeightPx}px`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="extended-pane">
        {stage === 2 ? (
          <ContextWorkbench
            messages={messages}
            selectedNodeIndexes={selectedNodeIndexes}
            tokenThresholds={tokenThresholds}
            sessionId={sessionId}
            isMainChatBusy={isMainChatBusy}
            history={contextWorkbenchHistory}
            revisions={contextRevisionHistory}
            pendingRestore={pendingContextRestore}
            reasoningOptions={reasoningOptions}
            onHistoryChange={onContextWorkbenchHistoryChange}
            onConversationChange={onContextWorkbenchConversationChange}
            onContextInputChange={onContextInputChange}
            onRevisionHistoryChange={onContextRevisionHistoryChange}
            onPendingRestoreChange={onPendingContextRestoreChange}
            onReviewPreviewStateChange={setIsContextReviewPreviewActive}
            onEnsureSession={onEnsureSession}
            onTokenThresholdsChange={setTokenThresholdsSafe}
          />
        ) : null}
      </div>
    </aside>
  );
}
