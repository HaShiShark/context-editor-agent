import { useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import type {
  OpenAISettings,
  ProviderType,
  ResponseProviderDraft,
  ResponseProviderModel,
  SettingsDraft,
  ToolSetting,
  ViewName,
} from '../types';
import ChatModelPicker from './ChatModelPicker';
import SettingsProvidersPanel from './SettingsProvidersPanel';
import './SettingsView.interface.css';
import hashIconUrl from '../assets/hash-icon.png';

type AppearanceMode = 'light' | 'dark';
type SettingsCategory = 'assistant' | 'me' | 'interface' | 'providers' | 'tools' | 'about';

interface SettingsViewProps {
  availableModels: string[];
  fetchingProviderId: string;
  isSaving: boolean;
  isSidebarResizing: boolean;
  openAISettings: OpenAISettings;
  resolvedThemeMode: AppearanceMode;
  savingProviderId: string;
  settingsDraft: SettingsDraft;
  serviceHintsEnabled: boolean;
  themeMode: AppearanceMode;
  view: ViewName;
  onClearApiKey: () => void;
  onDraftChange: (patch: Partial<SettingsDraft>) => void;
  onProviderDraftChange: (providerId: string, patch: Partial<ResponseProviderDraft>) => void;
  onProviderAdd: (providerType: ProviderType, providerName?: string) => string;
  onProviderDelete: (providerId: string) => Promise<string>;
  onProviderLoadModels: (providerId: string) => Promise<ResponseProviderModel[]>;
  onProviderPersist: (
    providerId: string,
    options?: {
      activate?: boolean;
      clearApiKey?: boolean;
      silent?: boolean;
    },
  ) => void;
  onSaveOpenAISettings: () => void;
  onSidebarResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onSwitchView: (view: ViewName) => void;
  onThemeModeChange: (value: AppearanceMode) => void;
  onToggleServiceHints: (enabled: boolean) => void;
}

const categories: Array<{ id: SettingsCategory; label: string; icon: string }> = [
  { id: 'assistant', label: '助手', icon: 'ph-user-circle' },
  { id: 'me', label: '我', icon: 'ph-user' },
  { id: 'interface', label: '外观', icon: 'ph-sun' },
  { id: 'providers', label: '供应商', icon: 'ph-pulse' },
  { id: 'tools', label: '工具', icon: 'ph-wrench' },
  { id: 'about', label: '关于', icon: 'ph-info' },
];

function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-paper-card settings-simple-section">
      <div className="settings-simple-head">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="settings-simple-field">
      <span>{label}</span>
      {hint ? <small>{hint}</small> : null}
      {children}
    </label>
  );
}

function ToggleButton({ checked, onClick }: { checked: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`settings-toggle ${checked ? 'is-on' : ''}`} aria-pressed={checked} onClick={onClick}>
      <span />
    </button>
  );
}

export default function SettingsView({
  availableModels,
  fetchingProviderId,
  isSaving,
  isSidebarResizing,
  openAISettings,
  resolvedThemeMode,
  savingProviderId,
  settingsDraft,
  serviceHintsEnabled,
  themeMode,
  view,
  onClearApiKey,
  onDraftChange,
  onProviderDraftChange,
  onProviderAdd,
  onProviderDelete,
  onProviderLoadModels,
  onProviderPersist,
  onSaveOpenAISettings,
  onSidebarResizeStart,
  onSwitchView,
  onThemeModeChange,
  onToggleServiceHints,
}: SettingsViewProps) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('assistant');
  const [settingsModelPickerOpen, setSettingsModelPickerOpen] = useState(false);

  const modelOptions = useMemo(
    () => Array.from(new Set([settingsDraft.default_model, ...availableModels].filter(Boolean))),
    [availableModels, settingsDraft.default_model],
  );
  const activeResponseProvider =
    settingsDraft.response_providers.find((provider) => provider.id === settingsDraft.active_provider_id) ||
    settingsDraft.response_providers[0];
  const activeResponseModel = activeResponseProvider?.models.find((model) => {
    const modelId = (model.id || model.label || '').trim();
    return modelId === settingsDraft.default_model;
  });
  const settingsModelLabel = activeResponseModel?.label || settingsDraft.default_model || modelOptions[0] || '选择模型';

  const handleSettingsModelSelect = (providerId: string, model: ResponseProviderModel) => {
    const modelId = (model.id || model.label || '').trim();
    if (!modelId) return;

    onDraftChange({
      active_provider_id: providerId,
      default_model: modelId,
      response_providers: settingsDraft.response_providers.map((provider) =>
        provider.id === providerId ? { ...provider, default_model: modelId } : provider,
      ),
    });
    setSettingsModelPickerOpen(false);
  };

  const renderSettingsModelButton = () => (
    <button type="button" className="settings-assistant-model-button" onClick={() => setSettingsModelPickerOpen(true)}>
      <span>{settingsModelLabel}</span>
      <i className="ph-light ph-caret-down" />
    </button>
  );

  const renderAssistant = () => (
    <div className="settings-simple-stack">
      <SettingsSection title="助手" description="保留核心行为设置，减少不必要的分页和视觉噪音。">
        <div className="settings-simple-grid">
          <Field label="助手名称">
            <input
              className="settings-field-input"
              value={settingsDraft.assistant_name}
              onChange={(event) => onDraftChange({ assistant_name: event.target.value })}
            />
          </Field>
          <Field label="默认模型">{renderSettingsModelButton()}</Field>
        </div>
        <Field label="开场方式">
          <textarea
            className="settings-textarea"
            rows={3}
            value={settingsDraft.assistant_greeting}
            onChange={(event) => onDraftChange({ assistant_greeting: event.target.value })}
          />
        </Field>
        <Field label="助手提示词">
          <textarea
            className="settings-textarea is-large"
            rows={8}
            value={settingsDraft.assistant_prompt}
            onChange={(event) => onDraftChange({ assistant_prompt: event.target.value })}
          />
        </Field>
      </SettingsSection>

      <SettingsSection title="生成参数">
        <div className="settings-simple-grid">
          <Field label="Temperature" hint="留空时使用模型默认值。">
            <input
              className="settings-field-input"
              value={settingsDraft.temperature}
              onChange={(event) => onDraftChange({ temperature: event.target.value, temperature_enabled: true })}
            />
          </Field>
          <Field label="Top P" hint="留空时使用模型默认值。">
            <input
              className="settings-field-input"
              value={settingsDraft.top_p}
              onChange={(event) => onDraftChange({ top_p: event.target.value, top_p_enabled: true })}
            />
          </Field>
        </div>
        <div className="settings-simple-row">
          <span>流式输出</span>
          <ToggleButton checked={settingsDraft.streaming} onClick={() => onDraftChange({ streaming: !settingsDraft.streaming })} />
        </div>
      </SettingsSection>
    </div>
  );

  const renderMe = () => (
    <div className="settings-simple-stack">
      <SettingsSection title="我的信息" description="这些信息会帮助助手用更贴近你的方式回答。">
        <div className="settings-simple-grid">
          <Field label="称呼">
            <input
              className="settings-field-input"
              value={settingsDraft.user_name}
              onChange={(event) => onDraftChange({ user_name: event.target.value })}
            />
          </Field>
          <Field label="语言">
            <select
              className="settings-field-input"
              value={settingsDraft.user_locale}
              onChange={(event) => onDraftChange({ user_locale: event.target.value })}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </select>
          </Field>
        </div>
        <Field label="时区">
          <input
            className="settings-field-input"
            value={settingsDraft.user_timezone}
            onChange={(event) => onDraftChange({ user_timezone: event.target.value })}
          />
        </Field>
        <Field label="关于我">
          <textarea
            className="settings-textarea is-large"
            rows={7}
            value={settingsDraft.user_profile}
            onChange={(event) => onDraftChange({ user_profile: event.target.value })}
          />
        </Field>
      </SettingsSection>
    </div>
  );

  const renderInterface = () => (
    <div className={`settings-appearance-shell mode-${resolvedThemeMode}`}>
      <h1>外观</h1>
      <section className="settings-appearance-panel settings-theme-panel">
        <div className="appearance-panel-head">
          <div>
            <strong>界面主题</strong>
            <span>只保留浅色和深色，让 hashcode 的 UI 更轻。</span>
          </div>
        </div>
        <div className="settings-theme-choice-grid" role="group" aria-label="主题模式">
          {[
            { value: 'light', label: '浅色', icon: 'ph-sun', note: '默认纸感界面，适合长时间工作。' },
            { value: 'dark', label: '深色', icon: 'ph-moon', note: '暖暗色界面，适合低光环境。' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              className={`settings-theme-choice${themeMode === option.value ? ' is-active' : ''}`}
              aria-pressed={themeMode === option.value}
              onClick={() => onThemeModeChange(option.value as AppearanceMode)}
            >
              <i className={`ph-light ${option.icon}`} />
              <span>{option.label}</span>
              <small>{option.note}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-appearance-panel compact settings-theme-summary">
        <div className="appearance-row stacked">
          <div>
            <span>当前模式</span>
            <small>{resolvedThemeMode === 'light' ? '浅色' : '深色'}</small>
          </div>
          <button type="button" className="settings-primary-btn" disabled={isSaving} onClick={onSaveOpenAISettings}>
            {isSaving ? '保存中...' : '保存外观设置'}
          </button>
        </div>
      </section>
    </div>
  );

  const renderTools = () => {
    const enabledCount = settingsDraft.tool_settings.filter((tool) => tool.enabled).length;
    const toggleTool = (toolName: string) => {
      const nextTools = settingsDraft.tool_settings.map((tool): ToolSetting =>
        tool.name === toolName ? { ...tool, enabled: !tool.enabled } : tool,
      );
      onDraftChange({ tool_settings: nextTools });
    };

    return (
      <div className="settings-tools-shell">
        <div className="settings-page-head settings-tools-head">
          <div>
            <h1>工具</h1>
            <p>控制会暴露给模型的本地工具。保存后，各供应商会共用同一份工具开关。</p>
          </div>
          <div className="settings-tools-counter">
            <strong>{enabledCount}</strong>
            <span>已开启</span>
          </div>
        </div>
        <div className="settings-tools-grid">
          {settingsDraft.tool_settings.map((tool) => (
            <section key={tool.name} className={`settings-tool-card${tool.enabled ? ' is-on' : ''}`}>
              <div className="settings-tool-card-main">
                <div className="settings-tool-icon">
                  <i className="ph-light ph-wrench" />
                </div>
                <div className="settings-tool-copy">
                  <strong>{tool.label || tool.name}</strong>
                  <p>{tool.description}</p>
                </div>
              </div>
              <ToggleButton checked={tool.enabled} onClick={() => toggleTool(tool.name)} />
            </section>
          ))}
        </div>
        <div className="settings-tools-footer">
          <button type="button" className="settings-primary-btn" disabled={isSaving} onClick={onSaveOpenAISettings}>
            {isSaving ? '保存中...' : '保存工具设置'}
          </button>
        </div>
      </div>
    );
  };

  const renderAbout = () => (
    <div className="settings-simple-stack">
      <SettingsSection title="关于">
        <div className="settings-about-hero">
          <div className="settings-about-icon">
            <img src={hashIconUrl} alt="hashcode" />
          </div>
          <h2>hashcode</h2>
          <p>本地上下文工作台</p>
          <span className="settings-about-version">v0.4.0</span>
        </div>
      </SettingsSection>
    </div>
  );

  const renderContent = () => {
    switch (activeCategory) {
      case 'assistant':
        return renderAssistant();
      case 'me':
        return renderMe();
      case 'interface':
        return renderInterface();
      case 'providers':
        return (
          <SettingsProvidersPanel
            fetchingProviderId={fetchingProviderId}
            openAISettings={openAISettings}
            savingProviderId={savingProviderId}
            settingsDraft={settingsDraft}
            onClearApiKey={onClearApiKey}
            onProviderDraftChange={onProviderDraftChange}
            onProviderAdd={onProviderAdd}
            onProviderDelete={onProviderDelete}
            onProviderLoadModels={onProviderLoadModels}
            onProviderPersist={onProviderPersist}
          />
        );
      case 'tools':
        return renderTools();
      case 'about':
        return renderAbout();
      default:
        return null;
    }
  };

  return (
    <div
      className={`settings-page ${view === 'settings' ? 'active' : ''}${activeCategory === 'providers' ? ' is-providers' : ''}${activeCategory === 'interface' ? ' is-interface' : ''}`}
    >
      <aside className="settings-sidebar">
        <div className="settings-sidebar-header">
          <h2>设置</h2>
          <p>保留真正会影响工作流的选项。</p>
        </div>
        <nav className="settings-nav">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`settings-nav-item ${activeCategory === cat.id ? 'active' : ''}`}
              onClick={() => setActiveCategory(cat.id)}
            >
              <i className={`ph-light ${cat.icon}`} />
              <span>{cat.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-sidebar-footer">
          <button type="button" className="back-btn" onClick={() => onSwitchView('chat')}>
            <i className="ph-light ph-arrow-left" />
            返回聊天
          </button>
        </div>
      </aside>

      <div
        className={`resizer resizer-left settings-resizer ${isSidebarResizing ? 'dragging' : ''}`}
        onMouseDown={onSidebarResizeStart}
      />

      <main className="settings-content">
        <div className="settings-content-scroll">
          <div key={activeCategory} className="settings-tab-panel">
            {renderContent()}
          </div>
        </div>
      </main>

      <ChatModelPicker
        activeProviderId={settingsDraft.active_provider_id}
        currentModel={settingsDraft.default_model}
        open={settingsModelPickerOpen}
        providers={settingsDraft.response_providers}
        title="选择聊天模型"
        description="切换后会更新设置里的默认聊天模型。"
        selectedContextLabel="设置默认"
        onClose={() => setSettingsModelPickerOpen(false)}
        onSelectModel={handleSettingsModelSelect}
      />
    </div>
  );
}
