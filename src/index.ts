import {
    Plugin,
    Setting,
    getAllEditor,
    showMessage,
} from "siyuan";
import "./index.scss";
declare const require: any;
import {DEFAULT_RUNTIME, DEFAULT_SETTINGS, mergeRuntime, mergeSettings} from "./common/settings";
import type {
    ChatMessage,
    ArtifactFormat,
    AttrSnapshot,
    ChatConversation,
    TianGongRuntime,
    TianGongSettings,
} from "./common/types";
import {
    appendBlock,
    createDocWithMd,
    extractImageSources,
    getBlockAttrs,
    getBlockKramdown,
    getHPathByID,
    getIDsByHPath,
    getPathByID,
    insertBlock,
    normalizeAssetUrl,
    setBlockAttrs,
    uploadAsset,
    updateBlock,
} from "./common/api";
import {analyzeImageBlock, analyzeTextBlock, generateArtifact, generateImage, probeChatModel, probeLLM} from "./common/llm";
import {getSkill, runAgentTurn} from "./common/agent";
import {closeMcpClients} from "./common/mcp";
import {getNativeToolDefinitions} from "./common/tools";

const LOCALE_FALLBACKS: Record<string, Record<string, string>> = {
    zh_CN: require("./i18n/zh_CN.json"),
    en_US: require("./i18n/en_US.json"),
};

const SETTINGS_STORAGE = "settings";
const RUNTIME_STORAGE = "runtime";
const DOCK_TYPE = "tiangong-ai-dock";

export default class TianGongAIPlugin extends Plugin {
    private settings: TianGongSettings = DEFAULT_SETTINGS;
    private runtime: TianGongRuntime = DEFAULT_RUNTIME;
    private dockElement: HTMLElement | null = null;
    private scanTimer: number | null = null;
    private menuDismissHandler: ((event: MouseEvent) => void) | null = null;
    private readonly fallbackI18n: Record<string, string> = this.getFallbackI18n();

    private t(key: string): string {
        const primary = this.i18n?.[key];
        const fallback = this.fallbackI18n[key] || LOCALE_FALLBACKS.zh_CN[key] || LOCALE_FALLBACKS.en_US[key];
        const value = typeof primary === "string" && primary.trim().length > 0 && primary !== key ? primary : fallback;
        return typeof value === "string" && value.trim().length > 0 ? value : key;
    }

    private tf(key: string, vars: Record<string, string | number>): string {
        return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), this.t(key));
    }

    private getFallbackI18n(): Record<string, string> {
        const siyuanLang = (window as any).siyuan?.config?.lang || "";
        const browserLang = navigator.language || "";
        const normalized = `${siyuanLang || browserLang}`.replace("-", "_").toLowerCase();
        const locale = normalized.startsWith("en") ? "en_US" : "zh_CN";
        return {
            ...LOCALE_FALLBACKS.zh_CN,
            ...LOCALE_FALLBACKS[locale],
        };
    }

    private readonly onWsMain = async ({detail}: any) => {
        if (!detail || detail.cmd !== "transactions") {
            return;
        }
        const rootIDs = Array.isArray(detail.context?.rootIDs) ? detail.context.rootIDs.filter(Boolean) : [];
        if (rootIDs.length === 0) {
            return;
        }
        this.runtime.recentRootIDs = Array.from(new Set([...rootIDs, ...this.runtime.recentRootIDs])).slice(0, 12);
        await this.persistRuntime();
        this.renderDock();
        this.scheduleRefresh(rootIDs);
    };

    private readonly onBlockIcon = ({detail}: any) => {
        const blockElements: HTMLElement[] = Array.isArray(detail?.blockElements) ? detail.blockElements : [];
        const blockId = this.getMenuBlockId(blockElements);
        if (!blockId) {
            return;
        }
        detail.menu.addItem({
            id: "tgai-mark-target",
            icon: "iconPin",
            label: this.t("menuMarkTarget"),
            click: async () => {
                this.runtime.lastTargetId = blockId;
                await this.persistRuntime();
                this.renderDock();
                showMessage(this.tf("targetMarked", {id: blockId}));
            },
        });
        detail.menu.addItem({
            id: "tgai-bind-target",
            icon: "iconLink",
            label: this.t("menuBindTarget"),
            click: async () => {
                await this.bindToTarget(blockId);
            },
        });
        detail.menu.addItem({
            id: "tgai-analyze",
            icon: "iconSparkles",
            label: this.t("menuAnalyze"),
            click: async () => {
                await this.analyzeBlock(blockId);
            },
        });
        detail.menu.addItem({
            id: "tgai-generate-image",
            icon: "iconImage",
            label: this.t("menuGenerateImage"),
            click: async () => {
                await this.generateImageBlock(blockId);
            },
        });
        detail.menu.addItem({
            id: "tgai-mermaid",
            icon: "iconGraph",
            label: this.t("menuGenerateMermaid"),
            click: async () => {
                await this.createArtifact(blockId, "mermaid");
            },
        });
        detail.menu.addItem({
            id: "tgai-tikz",
            icon: "iconMath",
            label: this.t("menuGenerateTikZ"),
            click: async () => {
                await this.createArtifact(blockId, "tikz");
            },
        });
        detail.menu.addItem({
            id: "tgai-excalidraw",
            icon: "iconCode",
            label: this.t("menuGenerateExcalidraw"),
            click: async () => {
                await this.createArtifact(blockId, "excalidraw");
            },
        });
        detail.menu.addItem({
            id: "tgai-html",
            icon: "iconCode",
            label: this.t("menuGenerateHtml"),
            click: async () => {
                await this.createArtifact(blockId, "html");
            },
        });
        detail.menu.addItem({
            id: "tgai-refresh-artifacts",
            icon: "iconRefresh",
            label: this.t("menuRefreshArtifacts"),
            click: async () => {
                await this.refreshArtifactsForSource(blockId);
            },
        });
        detail.menu.addItem({
            id: "tgai-restore",
            icon: "iconUndo",
            label: this.t("menuRestoreSnapshot"),
            click: async () => {
                await this.restoreLastSnapshot(blockId);
            },
        });
    };

    public async onload(): Promise<void> {
        this.settings = mergeSettings(await this.loadData(SETTINGS_STORAGE));
        this.runtime = mergeRuntime(await this.loadData(RUNTIME_STORAGE));
        this.eventBus.on("ws-main", this.onWsMain);
        this.eventBus.on("click-blockicon", this.onBlockIcon);

        this.addCommand({
            langKey: "openTianGongSettings",
            hotkey: "Mod+Shift+Y",
            callback: () => this.openSettings(),
        });
        this.addCommand({
            langKey: "probeTianGongLLM",
            hotkey: "Mod+Shift+P",
            callback: async () => {
                await this.probeLLM();
            },
        });
        this.addCommand({
            langKey: "analyzeCurrentDoc",
            hotkey: "Mod+Shift+A",
            editorCallback: async (protyle) => {
                await this.analyzeBlock(protyle.block.rootID);
            },
        });
        this.addCommand({
            langKey: "markCurrentDocAsTarget",
            hotkey: "Mod+Shift+T",
            editorCallback: async (protyle) => {
                this.runtime.lastTargetId = protyle.block.rootID;
                await this.persistRuntime();
                this.renderDock();
                showMessage(this.tf("targetMarked", {id: protyle.block.rootID}));
            },
        });
        this.addCommand({
            langKey: "generateMermaidCurrentDoc",
            hotkey: "Mod+Shift+M",
            editorCallback: async (protyle) => {
                await this.createArtifact(protyle.block.rootID, "mermaid");
            },
        });
        this.addCommand({
            langKey: "generateTikzCurrentDoc",
            hotkey: "Mod+Shift+K",
            editorCallback: async (protyle) => {
                await this.createArtifact(protyle.block.rootID, "tikz");
            },
        });
        this.addCommand({
            langKey: "generateImageCurrentDoc",
            editorCallback: async (protyle) => {
                await this.generateImageBlock(protyle.block.rootID);
            },
        });
        this.addCommand({
            langKey: "generateHtmlCurrentDoc",
            hotkey: "Mod+Shift+H",
            editorCallback: async (protyle) => {
                await this.createArtifact(protyle.block.rootID, "html");
            },
        });

        this.addDock({
            config: {
                position: "RightTop",
                size: {width: 320, height: 0},
                icon: "iconSparkles",
                title: this.t("pluginName"),
                hotkey: "",
            },
            data: {},
            type: DOCK_TYPE,
            init: (dock: any) => {
                this.dockElement = dock.element as HTMLElement;
                this.renderDock();
            },
            update: () => {
                this.renderDock();
            },
        });
    }

    public onLayoutReady(): void {
        this.addTopBar({
            icon: "iconSparkles",
            title: this.t("pluginName"),
            position: "right",
            callback: () => this.openSettings(),
        });
        this.renderDock();
    }

    public onunload(): void {
        if (this.scanTimer) {
            window.clearTimeout(this.scanTimer);
            this.scanTimer = null;
        }
        if (this.menuDismissHandler) {
            document.removeEventListener("click", this.menuDismissHandler, true);
            this.menuDismissHandler = null;
        }
        this.eventBus.off("ws-main", this.onWsMain);
        this.eventBus.off("click-blockicon", this.onBlockIcon);
        void closeMcpClients();
    }

    public onDataChanged(): void {
        // avoid plugin auto-reload after saveData
    }

    private renderDock(): void {
        this.renderCleanChatWorkspace();
    }

    private renderCleanChatWorkspace(): void {
        if (!this.dockElement) {
            return;
        }
        const conversation = this.getActiveConversation();
        const prompt = this.getActivePrompt();
        const activeModel = this.getActiveChatModel();
        const conversationTitle = this.getConversationDisplayTitle(conversation);
        const visiblePrompts = this.settings.agent.promptPresets.slice(0, 2);
        const overflowPrompts = this.settings.agent.promptPresets.slice(2);
        const conversationMenu = this.renderConversationMenu(conversation.id);
        const promptButtons = [
            ...visiblePrompts.map((item) => `
                <button
                    type="button"
                    class="tgai-prompt-chip${item.id === prompt.id ? " is-active" : ""}"
                    data-action="prompt-select"
                    data-prompt-id="${this.escapeHtml(item.id)}"
                    title="${this.escapeHtml(item.content || item.name)}"
                >${this.escapeHtml(item.name)}</button>
            `),
            overflowPrompts.length > 0
                ? `<details class="tgai-prompt-menu">
                        <summary class="tgai-prompt-chip tgai-prompt-chip--more" aria-label="${this.escapeHtml(this.t("settingsPromptPreset"))}" title="${this.escapeHtml(this.t("settingsPromptPreset"))}">...</summary>
                        <div class="tgai-prompt-menu__panel">
                            ${overflowPrompts.map((item) => `
                                <button
                                    type="button"
                                    class="tgai-prompt-menu__item${item.id === prompt.id ? " is-active" : ""}"
                                    data-action="prompt-select"
                                    data-prompt-id="${this.escapeHtml(item.id)}"
                                    title="${this.escapeHtml(item.content || item.name)}"
                                >${this.escapeHtml(item.name)}</button>
                            `).join("")}
                        </div>
                    </details>`
                : ""
        ].join("");
        const messages = this.renderConversationMessages(conversation.messages);
        const emptyState = `
            <div class="tgai-empty-state">
                ${this.renderUiIcon("empty")}
                <div>${this.t("emptyList")}</div>
            </div>`;
        this.dockElement.innerHTML = `
            <div class="tgai-shell tgai-shell--clean">
                <header class="tgai-topnav">
                    <div class="tgai-topnav__title">
                        <div class="tgai-topnav__name">${this.escapeHtml(conversationTitle)}</div>
                        <div class="tgai-topnav__meta">${this.escapeHtml(activeModel)}</div>
                    </div>
                    <div class="tgai-topnav__actions">
                        <button class="tgai-icon-ghost" data-action="new-chat" title="${this.escapeHtml(this.t("buttonNewChat"))}" aria-label="${this.escapeHtml(this.t("buttonNewChat"))}">${this.renderUiIcon("plus")}</button>
                        <details class="tgai-menu">
                            <summary class="tgai-icon-ghost" title="${this.escapeHtml(this.t("buttonSettings"))}" aria-label="${this.escapeHtml(this.t("buttonSettings"))}">${this.renderUiIcon("more")}</summary>
                            <div class="tgai-menu__panel">
                                ${conversationMenu}
                                <button data-action="chat-clear">${this.t("buttonClearChat")}</button>
                                <button data-action="restore">${this.t("buttonRollback")}</button>
                                <button data-action="settings">${this.t("buttonSettings")}</button>
                            </div>
                        </details>
                        <button class="tgai-icon-ghost" data-action="fullscreen" title="Fullscreen" aria-label="Fullscreen">${this.renderUiIcon("fullscreen")}</button>
                        <button class="tgai-icon-ghost" data-action="close-panel" title="Close" aria-label="Close">${this.renderUiIcon("close")}</button>
                    </div>
                </header>

                <main class="tgai-main${messages ? " tgai-main--messages" : ""}">
                    ${messages || emptyState}
                </main>

                <footer class="tgai-input-area">
                    <div class="tgai-prompt-strip" aria-label="${this.escapeHtml(this.t("settingsPromptPreset"))}">
                        ${promptButtons}
                        <div class="tgai-prompt-controls">
                            <button class="tgai-model-switch" data-action="model-cycle" title="${this.escapeHtml(this.t("buttonSwitchModel"))}" aria-label="${this.escapeHtml(this.t("buttonSwitchModel"))}">${this.escapeHtml(activeModel)}</button>
                            <button
                                type="button"
                                class="tgai-floating-toggle ${this.runtime.chat.includeCurrentTab ? "is-on" : ""}"
                                data-action="include-tab-toggle"
                                aria-pressed="${this.runtime.chat.includeCurrentTab ? "true" : "false"}"
                            >${this.t("labelIncludeTab")}</button>
                        </div>
                    </div>
                    <div class="tgai-composer">
                        <div class="tgai-input-box">
                            <textarea class="b3-text-field tgai-chatbox" data-action="chat-input" placeholder="${this.escapeHtml(this.t("placeholderChatInput"))}"></textarea>
                            <button class="tgai-send-icon" data-action="chat-send" title="${this.escapeHtml(this.t("buttonSend"))}" aria-label="${this.escapeHtml(this.t("buttonSend"))}">${this.renderUiIcon("send")}</button>
                        </div>
                    </div>
                </footer>
            </div>`;
        this.bindChatWorkspaceEvents();
    }

    private renderMinimalChatWorkspace(): void {
        this.renderCleanChatWorkspace();
    }
    private bindMinimalChatEvents(): void {
        this.dockElement?.querySelector('[data-action="settings"]')?.addEventListener("click", () => {
            this.openSettings();
        });
        this.dockElement?.querySelector('[data-action="new-chat"]')?.addEventListener("click", async () => {
            this.createConversation();
            await this.persistRuntime();
            this.renderDock();
        });
        this.dockElement?.querySelector('[data-action="conversation"]')?.addEventListener("change", async (event) => {
            const target = event.target as HTMLSelectElement;
            this.setActiveConversation(target.value || "default");
            await this.persistRuntime();
            this.renderDock();
        });
        this.dockElement?.querySelector('[data-action="chat-send"]')?.addEventListener("click", async () => {
            const input = this.dockElement?.querySelector('[data-action="chat-input"]') as HTMLTextAreaElement | null;
            const text = input?.value.trim() || "";
            if (!text) {
                return;
            }
            if (input) {
                input.value = "";
            }
            await this.sendChatMessage(text);
        });
        this.bindMessageActionButtons();
    }

    private renderUiIcon(name: string): string {
        const common = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
        switch (name) {
            case "fullscreen":
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${common} d="M7 3H3v4M13 3h4v4M7 17H3v-4M13 17h4v-4"/></svg>`;
            case "close":
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${common} d="M5 5l10 10M15 5L5 15"/></svg>`;
            case "refresh":
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${common} d="M16 8V4h-4M4 12v4h4M5.5 7.5A6 6 0 0 1 15 6.5L16 8M4 12l1 1.5A6 6 0 0 0 14.5 12.5"/></svg>`;
            case "settings":
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${common} d="M8.5 3.5h3L12 5.2a6.6 6.6 0 0 1 1.3.8l1.7-.6 1.5 2.6-1.4 1a6.6 6.6 0 0 1 0 1.6l1.4 1-1.5 2.6-1.7-.6a6.6 6.6 0 0 1-1.3.8l-.5 1.7h-3L8 15.5a6.6 6.6 0 0 1-1.3-.8l-1.7.6-1.5-2.6 1.4-1a6.6 6.6 0 0 1 0-1.6l-1.4-1 1.5-2.6 1.7.6a6.6 6.6 0 0 1 1.3-.8z"/><circle ${common} cx="10" cy="10" r="2.2"/></svg>`;
            case "edit":
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${common} d="M4 15.5V16h.5L14 6.5 13.5 6 4 15.5z"/><path ${common} d="M12.5 4.5l3 3"/></svg>`;
            case "more":
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${common} d="M5 10h.01M10 10h.01M15 10h.01"/></svg>`;
            case "plus":
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${common} d="M10 4v12M4 10h12"/></svg>`;
            case "chevron":
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${common} d="M6 8l4 4 4-4"/></svg>`;
            case "send":
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${common} d="M3.5 10L16.5 3.8l-3 12.4-3.6-4-6.4-2.2z"/><path ${common} d="M8 12l5.5-5.5"/></svg>`;
            case "empty":
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${common} d="M5 6.5A4.5 4.5 0 0 1 13.5 5 3.5 3.5 0 0 1 15 11.5H7A3 3 0 1 1 5 6.5z"/><path ${common} d="M8 13l1.5-1.5L11 13l1.5-1.5"/></svg>`;
            default:
                return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle ${common} cx="10" cy="10" r="7"/></svg>`;
        }
    }

    private renderChatWorkspace(): void {
        this.renderCleanChatWorkspace();
    }

    private bindChatWorkspaceEvents(): void {
        this.dockElement?.querySelectorAll('[data-action="settings"]').forEach((item) => {
            item.addEventListener("click", () => {
                this.openSettings();
            });
        });
        this.dockElement?.querySelectorAll('[data-action="fullscreen"]').forEach((item) => {
            item.addEventListener("click", () => {
                this.dockElement?.querySelector(".tgai-shell--clean")?.classList.toggle("tgai-shell--fullscreen");
            });
        });
        this.dockElement?.querySelectorAll('[data-action="close-panel"]').forEach((item) => {
            item.addEventListener("click", () => {
                this.dockElement?.querySelector(".tgai-shell--clean")?.classList.toggle("tgai-shell--minimized");
            });
        });
        this.dockElement?.querySelectorAll('[data-action="new-chat"]').forEach((item) => {
            item.addEventListener("click", async () => {
                this.createConversation();
                await this.persistRuntime();
                this.renderDock();
            });
        });
        this.dockElement?.querySelectorAll<HTMLElement>('[data-action="conversation-select"]').forEach((item) => {
            item.addEventListener("click", async () => {
                const conversationId = item.dataset.conversationId || "";
                if (!conversationId) {
                    return;
                }
                this.setActiveConversation(conversationId);
                await this.persistRuntime();
                this.renderDock();
            });
        });
        this.dockElement?.querySelectorAll<HTMLElement>('[data-action="prompt-select"]').forEach((item) => {
            item.addEventListener("click", async () => {
                const promptId = item.dataset.promptId || "";
                if (!promptId) {
                    return;
                }
                this.runtime.chat.activePromptId = promptId;
                const activeConversation = this.runtime.chat.conversations.find((conversation) => conversation.id === this.runtime.chat.activeConversationId);
                if (activeConversation) {
                    activeConversation.activePromptId = promptId;
                    activeConversation.updatedAt = Date.now();
                }
                await this.persistRuntime();
                this.renderDock();
            });
        });
        this.dockElement?.querySelectorAll('[data-action="include-tab-toggle"]').forEach((item) => {
            item.addEventListener("click", async () => {
                this.runtime.chat.includeCurrentTab = !this.runtime.chat.includeCurrentTab;
                await this.persistRuntime();
                this.renderDock();
            });
        });
        this.dockElement?.querySelector('[data-action="skill"]')?.addEventListener("change", async (event) => {
            const target = event.target as HTMLSelectElement;
            this.runtime.chat.activeSkillId = target.value || "chat";
            await this.persistRuntime();
            this.renderDock();
        });
        this.dockElement?.querySelector('[data-action="model-cycle"]')?.addEventListener("click", async () => {
            this.settings.agent.model = this.getNextChatModel();
            await this.persistSettings();
            this.renderDock();
        });
        this.dockElement?.querySelectorAll('[data-action="chat-clear"]').forEach((item) => {
            item.addEventListener("click", async () => {
                const conversation = this.getActiveConversation();
                conversation.messages.length = 0;
                conversation.updatedAt = Date.now();
                this.runtime.chat.messages = conversation.messages;
                await this.persistRuntime();
                this.renderDock();
            });
        });
        this.dockElement?.querySelectorAll('[data-action="restore"]').forEach((item) => {
            item.addEventListener("click", async () => {
                const current = this.getCurrentEditorBlockId();
                if (current) {
                    await this.restoreLastSnapshot(current);
                }
            });
        });
        this.dockElement?.querySelector('[data-action="chat-send"]')?.addEventListener("click", async () => {
            const input = this.dockElement?.querySelector('[data-action="chat-input"]') as HTMLTextAreaElement | null;
            const text = input?.value.trim() || "";
            if (!text) {
                return;
            }
            if (input) {
                input.value = "";
            }
            await this.sendChatMessage(text);
        });
        this.dockElement?.querySelector('[data-action="chat-input"]')?.addEventListener("keydown", async (event) => {
            const keyboardEvent = event as KeyboardEvent;
            if (keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) {
                keyboardEvent.preventDefault();
                const input = this.dockElement?.querySelector('[data-action="chat-input"]') as HTMLTextAreaElement | null;
                const text = input?.value.trim() || "";
                if (!text) {
                    return;
                }
                if (input) {
                    input.value = "";
                }
                await this.sendChatMessage(text);
            }
        });
        this.dockElement?.querySelectorAll('[data-action="quick-prompt"]').forEach((item) => {
            item.addEventListener("click", () => {
                const input = this.dockElement?.querySelector('[data-action="chat-input"]') as HTMLTextAreaElement | null;
                const promptText = (item as HTMLElement).dataset.prompt || "";
                if (input) {
                    input.value = promptText;
                    input.focus();
                }
            });
        });
        if (this.menuDismissHandler) {
            document.removeEventListener("mousedown", this.menuDismissHandler, true);
        }
        this.menuDismissHandler = (event: MouseEvent) => {
            if (!this.dockElement) {
                return;
            }
            const target = event.target as Node | null;
            if (target && (target as HTMLElement).closest?.(".tgai-menu, .tgai-prompt-menu")) {
                return;
            }
            this.dockElement.querySelectorAll("details[open]").forEach((item) => {
                (item as HTMLDetailsElement).open = false;
            });
        };
        document.addEventListener("click", this.menuDismissHandler, true);
        this.bindMessageActionButtons();
    }

    private renderDockLegacy(): void {
        if (!this.dockElement) {
            return;
        }
        const skill = getSkill(this.settings, this.runtime.chat.activeSkillId);
        const activeModel = this.settings.agent.model.trim() || this.settings.llm.model;
        const enabledMcpCount = this.settings.agent.mcpServers.filter((item) => item.enabled).length;
        const enabledNativeCount = this.settings.agent.enabledTools.length;
        const skillOptions = this.settings.agent.skills.map((item) => `
            <option value="${this.escapeHtml(item.id)}" ${item.id === skill.id ? "selected" : ""}>${this.escapeHtml(item.name)}</option>
        `).join("");
        const messages = this.runtime.chat.messages.slice(-24).map((message) => this.renderChatMessage(message)).join("");
                this.dockElement.innerHTML = `
            <div class="tgai-dock">
                <div class="tgai-header">
                    <div class="tgai-header__title">
                        <div class="tgai-pill">TGAI</div>
                        <div class="tgai-header__meta">
                            <div class="tgai-header__name">${this.escapeHtml(skill.name)}</div>
                            <div class="tgai-muted">${this.escapeHtml(skill.description)}</div>
                            <div class="tgai-muted">模型 ${this.escapeHtml(activeModel)} · 工具 ${enabledNativeCount} · MCP ${enabledMcpCount}</div>
                        </div>
                    </div>
                    <div class="tgai-header__actions">
                        <button class="b3-button b3-button--outline tgai-icon-button" data-action="probe" title="${this.escapeHtml(this.t("buttonProbe"))}">◎</button>
                        <button class="b3-button b3-button--outline tgai-icon-button" data-action="settings" title="${this.escapeHtml(this.t("buttonSettings"))}">⚙</button>
                    </div>
                </div>
                <div class="tgai-strip">
                    <select class="b3-select tgai-select" data-action="skill">
                        ${skillOptions}
                    </select>
                    <input class="b3-text-field tgai-model" data-action="agent-model" value="${this.escapeHtml(this.settings.agent.model)}" placeholder="${this.escapeHtml(this.t("placeholderAgentModel"))}">
                </div>
                <div class="tgai-chatlog">
                    ${messages || `<div class="tgai-empty">${this.t("emptyList")}</div>`}
                </div>
                <div class="tgai-chatinput">
                    <textarea class="b3-text-field fn__block tgai-chatbox" data-action="chat-input" placeholder="${this.escapeHtml(this.t("placeholderChatInput"))}"></textarea>
                    <div class="tgai-row tgai-actions">
                        <button class="b3-button b3-button--outline tgai-button" data-action="chat-clear">${this.t("buttonClearChat")}</button>
                        <button class="b3-button b3-button--outline tgai-button" data-action="restore">${this.t("buttonRollback")}</button>
                        <button class="b3-button b3-button--primary tgai-button tgai-button--send" data-action="chat-send">${this.t("buttonSend")}</button>
                    </div>
                </div>
            </div>`;
        this.dockElement.querySelector('[data-action="probe"]')?.addEventListener("click", async () => {
            await this.probeLLM();
        });
        this.dockElement.querySelector('[data-action="settings"]')?.addEventListener("click", () => {
            this.openSettings();
        });
        this.dockElement.querySelector('[data-action="skill"]')?.addEventListener("change", (event) => {
            const target = event.target as HTMLSelectElement;
            this.runtime.chat.activeSkillId = target.value || "chat";
            void this.persistRuntime();
        });
        this.dockElement.querySelector('[data-action="agent-model"]')?.addEventListener("change", (event) => {
            const target = event.target as HTMLInputElement;
            this.settings.agent.model = target.value.trim();
            void this.persistSettings();
        });
        this.dockElement.querySelector('[data-action="restore"]')?.addEventListener("click", async () => {
            const current = this.getCurrentEditorBlockId();
            if (current) {
                await this.restoreLastSnapshot(current);
            }
        });
        this.dockElement.querySelector('[data-action="chat-clear"]')?.addEventListener("click", async () => {
            this.runtime.chat.messages = [];
            await this.persistRuntime();
            this.renderDock();
        });
        this.dockElement.querySelector('[data-action="chat-send"]')?.addEventListener("click", async () => {
            const input = this.dockElement?.querySelector('[data-action="chat-input"]') as HTMLTextAreaElement | null;
            const text = input?.value.trim() || "";
            if (!text) {
                return;
            }
            if (input) {
                input.value = "";
            }
            await this.sendChatMessage(text);
        });
    }

    private createSettingsWorkspace(): HTMLElement {
        const primaryMcp = this.settings.agent.mcpServers[0];
        const promptPresets = this.settings.agent.promptPresets.length > 0
            ? this.settings.agent.promptPresets
            : [{
                id: "default",
                name: this.t("promptUntitled"),
                content: "",
                createdAt: Date.now(),
            }];
        if (this.settings.agent.promptPresets.length === 0) {
            this.settings.agent.promptPresets = [...promptPresets];
        }
        const activePrompt = this.getActivePrompt();
        let activePromptId = activePrompt.id;
        const panel = document.createElement("div");
        panel.className = "tgai-settings-workspace";
        panel.style.border = "0";
        panel.style.borderRadius = "0";
        panel.style.background = "transparent";
        panel.style.boxShadow = "none";
        panel.style.outline = "none";
        panel.innerHTML = `
            <header class="tgai-settings-head">
                <div>
                    <div class="tgai-settings-kicker">TianGong AI</div>
                    <div class="tgai-settings-title">${this.t("settingsWorkspace")}</div>
                </div>
                <div class="tgai-settings-note">${this.t("settingsSaved")}</div>
            </header>
            <nav class="tgai-settings-tabs">
                <button type="button" class="is-active" data-section-target="model">${this.t("settingsNavModel")}</button>
                <button type="button" data-section-target="chat">${this.t("settingsNavChat")}</button>
                <button type="button" data-section-target="prompt">${this.t("settingsNavPrompt")}</button>
                <button type="button" data-section-target="tools">${this.t("settingsNavTools")}</button>
                <button type="button" data-section-target="mcp">${this.t("settingsNavMcp")}</button>
                <button type="button" data-section-target="diagram">${this.t("settingsNavDiagram")}</button>
            </nav>
            <div class="tgai-settings-sections">
                <section class="tgai-settings-section is-active" data-section="model">
                    ${this.renderSettingField("settingsBaseUrl", "base-url", this.settings.llm.baseUrl, "placeholderBaseUrl")}
                    ${this.renderSettingField("settingsModel", "model", this.settings.llm.model, "placeholderModel")}
                    ${this.renderSettingField("settingsApiKey", "api-key", this.settings.llm.apiKey, "placeholderApiKey", "password")}
                    <div class="tgai-settings-row">
                        <button type="button" class="b3-button b3-button--outline" data-setting="probe-model">${this.t("buttonTestModel")}</button>
                    </div>
                    <div class="tgai-settings-probe" data-role="probe-status"></div>
                </section>
                <section class="tgai-settings-section" data-section="chat">
                    ${this.renderSettingField("settingsAgentModel", "agent-model", this.settings.agent.model, "placeholderAgentModel")}
                    ${this.renderSettingField("settingsAgentTurns", "turns", String(this.settings.agent.maxTurns), "", "number")}
                    ${this.renderSettingArea("settingsSystemPrompt", "system-prompt", this.settings.agent.systemPrompt, "placeholderSystemPrompt")}
                </section>
                <section class="tgai-settings-section" data-section="prompt">
                    <div class="tgai-field tgai-field--wide">
                        <label>${this.t("settingsPromptPreset")}</label>
                        <div class="tgai-prompt-strip tgai-prompt-strip--settings" data-role="prompt-strip"></div>
                    </div>
                    ${this.renderSettingField("settingsPromptName", "prompt-name", activePrompt.name, "placeholderPromptName")}
                    ${this.renderSettingArea("settingsPromptContent", "prompt-content", activePrompt.content, "placeholderPromptContent")}
                    <div class="tgai-settings-row">
                        <button type="button" class="b3-button b3-button--outline" data-setting="prompt-new">${this.t("settingsPromptNew")}</button>
                        <button type="button" class="b3-button b3-button--outline" data-setting="prompt-delete">${this.t("settingsPromptDelete")}</button>
                    </div>
                </section>
                <section class="tgai-settings-section" data-section="tools">
                    <div class="tgai-field">
                        <label>${this.t("settingsTools")}</label>
                        ${this.renderToolSettingToggles()}
                    </div>
                    <label class="tgai-tool-toggle tgai-field-inline">
                        <input type="checkbox" data-setting="auto-analyze" ${this.settings.binding.autoAnalyzeOnTransaction ? "checked" : ""}>
                        <span>${this.t("settingsAutoAnalyze")}</span>
                    </label>
                    ${this.renderSettingField("settingsDebounceMs", "debounce", String(this.settings.binding.debounceMs), "", "number")}
                </section>
                <section class="tgai-settings-section" data-section="mcp">
                    <label class="tgai-tool-toggle tgai-field-inline">
                        <input type="checkbox" data-setting="mcp-enabled" ${primaryMcp?.enabled ? "checked" : ""}>
                        <span>${this.t("settingsMcpEnable")}</span>
                    </label>
                    ${this.renderSettingField("settingsMcpName", "mcp-name", primaryMcp?.name || "Primary MCP", "")}
                    ${this.renderSettingField("settingsMcpUrl", "mcp-url", primaryMcp?.url || "", "placeholderMcpUrl")}
                    ${this.renderSettingField("settingsMcpTools", "mcp-tools", primaryMcp?.allowTools?.join(", ") || "", "placeholderMcpTools")}
                </section>
                <section class="tgai-settings-section" data-section="diagram">
                    ${this.renderSettingField("settingsArtifactModel", "artifact-model", this.settings.artifact.model, "placeholderArtifactModel")}
                    ${this.renderSettingField("settingsImageModel", "image-model", this.settings.artifact.imageModel, "placeholderImageModel")}
                    ${this.renderSettingArea("settingsImagePrompt", "image-prompt", this.settings.artifact.imagePrompt, "placeholderImagePrompt")}
                    ${this.renderSettingArea("settingsMermaidPrompt", "mermaid-prompt", this.settings.artifact.prompts.mermaid, "placeholderMermaidPrompt")}
                    ${this.renderSettingArea("settingsTikzPrompt", "tikz-prompt", this.settings.artifact.prompts.tikz, "placeholderTikzPrompt")}
                    ${this.renderSettingArea("settingsExcalidrawPrompt", "excalidraw-prompt", this.settings.artifact.prompts.excalidraw, "placeholderExcalidrawPrompt")}
                    ${this.renderSettingArea("settingsHtmlPrompt", "html-prompt", this.settings.artifact.prompts.html, "placeholderHtmlPrompt")}
                </section>
            </div>`;
        const probeStatus = panel.querySelector<HTMLElement>('[data-role="probe-status"]');
        const setProbeStatus = (text: string, state: "idle" | "loading" | "success" | "error" = "idle"): void => {
            if (!probeStatus) {
                return;
            }
            probeStatus.textContent = text;
            probeStatus.classList.remove("is-loading", "is-success", "is-error");
            if (state !== "idle") {
                probeStatus.classList.add(`is-${state}`);
            }
        };
        const readModelTestSettings = (): TianGongSettings => ({
            ...this.settings,
            llm: {
                ...this.settings.llm,
                baseUrl: panel.querySelector<HTMLInputElement>('[data-setting="base-url"]')?.value.trim() || this.settings.llm.baseUrl,
                model: panel.querySelector<HTMLInputElement>('[data-setting="model"]')?.value.trim() || this.settings.llm.model,
                apiKey: panel.querySelector<HTMLInputElement>('[data-setting="api-key"]')?.value.trim() || "",
            },
        });
        panel.querySelectorAll<HTMLElement>("[data-section-target]").forEach((button) => {
            button.addEventListener("click", () => {
                const target = button.dataset.sectionTarget || "model";
                panel.querySelectorAll(".tgai-settings-tabs button").forEach((item) => item.classList.toggle("is-active", item === button));
                panel.querySelectorAll<HTMLElement>("[data-section]").forEach((section) => {
                    section.classList.toggle("is-active", section.dataset.section === target);
                });
            });
        });
        const promptStrip = panel.querySelector<HTMLElement>('[data-role="prompt-strip"]');
        const promptNameInput = panel.querySelector<HTMLInputElement>('[data-setting="prompt-name"]');
        const promptContentInput = panel.querySelector<HTMLTextAreaElement>('[data-setting="prompt-content"]');
        const renderPromptStrip = (): void => {
            if (!promptStrip) {
                return;
            }
            promptStrip.innerHTML = this.settings.agent.promptPresets.map((item) => `
                <button
                    type="button"
                    class="tgai-prompt-chip${item.id === activePromptId ? " is-active" : ""}"
                    data-setting="prompt-select"
                    data-prompt-id="${this.escapeHtml(item.id)}"
                    title="${this.escapeHtml(item.content || item.name)}"
                >${this.escapeHtml(item.name)}</button>
            `).join("");
        };
        const refreshPromptEditor = (promptId: string) => {
            const current = this.settings.agent.promptPresets.find((item) => item.id === promptId)
                || this.settings.agent.promptPresets[0]
                || promptPresets[0];
            activePromptId = current.id;
            panel.dataset.activePromptId = current.id;
            if (promptNameInput) {
                promptNameInput.value = current.name;
            }
            if (promptContentInput) {
                promptContentInput.value = current.content;
            }
            renderPromptStrip();
        };
        promptStrip?.addEventListener("click", (event) => {
            const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-setting="prompt-select"]');
            if (!button) {
                return;
            }
            refreshPromptEditor(button.dataset.promptId || activePromptId);
        });
        panel.querySelector('[data-setting="prompt-new"]')?.addEventListener("click", () => {
            const id = this.createPromptId();
            const created = {
                id,
                name: `${this.t("promptUntitled")} ${Date.now().toString().slice(-4)}`,
                content: "",
                createdAt: Date.now(),
            };
            this.settings.agent.promptPresets = [...this.settings.agent.promptPresets, created];
            refreshPromptEditor(created.id);
        });
        panel.querySelector('[data-setting="prompt-delete"]')?.addEventListener("click", () => {
            const promptId = activePromptId;
            if (!promptId || this.settings.agent.promptPresets.length <= 1) {
                return;
            }
            this.settings.agent.promptPresets = this.settings.agent.promptPresets.filter((item) => item.id !== promptId);
            const fallback = this.settings.agent.promptPresets[0];
            refreshPromptEditor(fallback.id);
        });
        panel.querySelector('[data-setting="probe-model"]')?.addEventListener("click", async () => {
            const modelButton = panel.querySelector<HTMLButtonElement>('[data-setting="probe-model"]');
            const draft = readModelTestSettings();
            if (modelButton) {
                modelButton.disabled = true;
            }
            try {
                setProbeStatus(this.t("testingModel"), "loading");
                showMessage(this.t("testingModel"));
                const result = await probeChatModel(draft);
                const message = result.ok
                    ? this.tf("modelProbeSuccess", {model: draft.llm.model || this.t("placeholderModel")})
                    : this.tf("modelProbeFailure", {message: result.message});
                setProbeStatus(message, result.ok ? "success" : "error");
                showMessage(message);
            } finally {
                if (modelButton) {
                    modelButton.disabled = false;
                }
            }
        });
        refreshPromptEditor(activePromptId);
        return panel;
    }

    private renderSettingField(titleKey: string, settingId: string, value: string, placeholderKey = "", type = "text"): string {
        return `
            <div class="tgai-field">
                <label>${this.t(titleKey)}</label>
                <input type="${type}" class="b3-text-field fn__block" data-setting="${settingId}" value="${this.escapeHtml(value)}" placeholder="${this.escapeHtml(placeholderKey ? this.t(placeholderKey) : "")}">
            </div>`;
    }

    private renderSettingArea(titleKey: string, settingId: string, value: string, placeholderKey = ""): string {
        return `
            <div class="tgai-field tgai-field--wide">
                <label>${this.t(titleKey)}</label>
                <textarea class="b3-text-field fn__block tgai-textarea" data-setting="${settingId}" placeholder="${this.escapeHtml(placeholderKey ? this.t(placeholderKey) : "")}">${this.escapeHtml(value)}</textarea>
            </div>`;
    }

    private renderToolSettingToggles(): string {
        return `<div class="tgai-tool-grid">${getNativeToolDefinitions(this.settings).map((tool) => `
            <label class="tgai-tool-toggle">
                <input type="checkbox" data-setting="tool" value="${this.escapeHtml(tool.id)}" ${tool.enabled ? "checked" : ""}>
                <span>${this.escapeHtml(this.getToolLabel(tool.id, tool.title))}</span>
            </label>
        `).join("")}</div>`;
    }

    private openSettings(): void {
        const panel = this.createSettingsWorkspace();
        const setting = new Setting({
            confirmCallback: async () => {
                const toolToggles = panel.querySelectorAll<HTMLInputElement>('[data-setting="tool"]');
                const mcpEnabled = panel.querySelector<HTMLInputElement>('[data-setting="mcp-enabled"]')?.checked || false;
                const mcpUrl = panel.querySelector<HTMLInputElement>('[data-setting="mcp-url"]')?.value.trim() || "";
                const mcpName = panel.querySelector<HTMLInputElement>('[data-setting="mcp-name"]')?.value.trim() || "MCP";
                const mcpTools = (panel.querySelector<HTMLInputElement>('[data-setting="mcp-tools"]')?.value || "")
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean);
                const promptId = panel.dataset.activePromptId || this.runtime.chat.activePromptId || "default";
                const promptName = panel.querySelector<HTMLInputElement>('[data-setting="prompt-name"]')?.value.trim() || this.t("promptUntitled");
                const promptContent = panel.querySelector<HTMLTextAreaElement>('[data-setting="prompt-content"]')?.value.trim() || "";
                const existingPrompt = this.settings.agent.promptPresets.find((item) => item.id === promptId);
                const updatedPrompt = {
                    id: promptId,
                    name: promptName,
                    content: promptContent,
                    createdAt: existingPrompt?.createdAt || Date.now(),
                };
                this.settings = {
                    ...this.settings,
                    llm: {
                        ...this.settings.llm,
                        baseUrl: panel.querySelector<HTMLInputElement>('[data-setting="base-url"]')?.value.trim() || this.settings.llm.baseUrl,
                        model: panel.querySelector<HTMLInputElement>('[data-setting="model"]')?.value.trim() || this.settings.llm.model,
                        apiKey: panel.querySelector<HTMLInputElement>('[data-setting="api-key"]')?.value.trim() || "",
                    },
                    artifact: {
                        model: panel.querySelector<HTMLInputElement>('[data-setting="artifact-model"]')?.value.trim() || "",
                        imageModel: panel.querySelector<HTMLInputElement>('[data-setting="image-model"]')?.value.trim() || "gpt-image-1",
                        imagePrompt: panel.querySelector<HTMLTextAreaElement>('[data-setting="image-prompt"]')?.value.trim() || this.settings.artifact.imagePrompt,
                        prompts: {
                            mermaid: panel.querySelector<HTMLTextAreaElement>('[data-setting="mermaid-prompt"]')?.value.trim() || this.settings.artifact.prompts.mermaid,
                            tikz: panel.querySelector<HTMLTextAreaElement>('[data-setting="tikz-prompt"]')?.value.trim() || this.settings.artifact.prompts.tikz,
                            excalidraw: panel.querySelector<HTMLTextAreaElement>('[data-setting="excalidraw-prompt"]')?.value.trim() || this.settings.artifact.prompts.excalidraw,
                            html: panel.querySelector<HTMLTextAreaElement>('[data-setting="html-prompt"]')?.value.trim() || this.settings.artifact.prompts.html,
                        },
                    },
                    agent: {
                        ...this.settings.agent,
                        model: panel.querySelector<HTMLInputElement>('[data-setting="agent-model"]')?.value.trim() || "",
                        systemPrompt: panel.querySelector<HTMLTextAreaElement>('[data-setting="system-prompt"]')?.value.trim() || this.settings.agent.systemPrompt,
                        maxTurns: Number(panel.querySelector<HTMLInputElement>('[data-setting="turns"]')?.value || 6) || 6,
                        enabledTools: Array.from(toolToggles).filter((item) => item.checked).map((item) => item.value),
                        promptPresets: existingPrompt
                            ? this.settings.agent.promptPresets.map((item) => item.id === promptId ? updatedPrompt : item)
                            : [updatedPrompt, ...this.settings.agent.promptPresets],
                        mcpServers: mcpUrl ? [{
                            id: "primary",
                            name: mcpName,
                            transport: "streamable-http",
                            command: "",
                            args: [],
                            url: mcpUrl,
                            enabled: mcpEnabled,
                            allowTools: mcpTools,
                        }] : [],
                    },
                    binding: {
                        debounceMs: Number(panel.querySelector<HTMLInputElement>('[data-setting="debounce"]')?.value || 650) || 650,
                        autoAnalyzeOnTransaction: panel.querySelector<HTMLInputElement>('[data-setting="auto-analyze"]')?.checked || false,
                    },
                };
                this.runtime.chat.activePromptId = promptId;
                const activeConversation = this.runtime.chat.conversations.find((item) => item.id === this.runtime.chat.activeConversationId);
                if (activeConversation) {
                    activeConversation.activePromptId = promptId;
                    activeConversation.updatedAt = Date.now();
                }
                await this.persistSettings();
                await this.persistRuntime();
                showMessage(this.t("settingsSaved"));
                this.renderDock();
            },
        });
        setting.addItem({
            title: "",
            direction: "column",
            createActionElement: () => panel,
        });
        setting.open("");
        const decorateSettingsDialog = (): boolean => {
            const dialog = panel.closest(".b3-dialog") as HTMLElement | null;
            if (!dialog) {
                return false;
            }
            dialog.classList.add("tgai-settings-dialog");
            dialog.classList.add("tgai-settings-dialog--compact");
            dialog.querySelectorAll<HTMLElement>(".b3-dialog__container, .b3-dialog__header, .b3-dialog__content, .b3-dialog__body").forEach((item) => {
                item.style.background = "transparent";
                item.style.border = "0";
                item.style.boxShadow = "none";
                item.style.padding = "0";
            });
            const header = dialog.querySelector<HTMLElement>(".b3-dialog__header");
            if (header) {
                header.style.padding = "4px 12px 0";
                header.style.minHeight = "28px";
                header.style.marginBottom = "0";
                header.querySelectorAll<HTMLElement>("*").forEach((item) => {
                    if (item.textContent?.trim() === this.t("pluginName")) {
                        item.style.display = "none";
                    }
                });
            }
            return true;
        };
        if (!decorateSettingsDialog()) {
            window.setTimeout(() => decorateSettingsDialog(), 0);
            window.setTimeout(() => decorateSettingsDialog(), 80);
            window.setTimeout(() => decorateSettingsDialog(), 200);
        }
    }
    private openSettingsLegacy(): void {
        const baseUrlInput = document.createElement("input");
        baseUrlInput.className = "b3-text-field fn__block";
        baseUrlInput.value = this.settings.llm.baseUrl;
        baseUrlInput.placeholder = this.t("placeholderBaseUrl");

        const modelInput = document.createElement("input");
        modelInput.className = "b3-text-field fn__block";
        modelInput.value = this.settings.llm.model;
        modelInput.placeholder = this.t("placeholderModel");

        const apiKeyInput = document.createElement("input");
        apiKeyInput.className = "b3-text-field fn__block";
        apiKeyInput.value = this.settings.llm.apiKey;
        apiKeyInput.placeholder = this.t("placeholderApiKey");

        const artifactModelInput = document.createElement("input");
        artifactModelInput.className = "b3-text-field fn__block";
        artifactModelInput.value = this.settings.artifact.model;
        artifactModelInput.placeholder = this.t("placeholderArtifactModel");

        const agentModelInput = document.createElement("input");
        agentModelInput.className = "b3-text-field fn__block";
        agentModelInput.value = this.settings.agent.model;
        agentModelInput.placeholder = this.t("placeholderAgentModel");

        const agentSystemPromptInput = this.createTextArea(
            this.settings.agent.systemPrompt,
            this.t("placeholderSystemPrompt"),
        );

        const agentTurnsInput = document.createElement("input");
        agentTurnsInput.type = "number";
        agentTurnsInput.className = "b3-text-field fn__block";
        agentTurnsInput.value = String(this.settings.agent.maxTurns);

        const toolToggles = this.createToolToggleGroup();

        const mcpServersInput = this.createTextArea(
            JSON.stringify(this.settings.agent.mcpServers, null, 2),
            this.t("placeholderMcpServers"),
        );

        const mermaidPromptInput = this.createTextArea(
            this.settings.artifact.prompts.mermaid,
            this.t("placeholderMermaidPrompt"),
        );
        const tikzPromptInput = this.createTextArea(
            this.settings.artifact.prompts.tikz,
            this.t("placeholderTikzPrompt"),
        );
        const excalidrawPromptInput = this.createTextArea(
            this.settings.artifact.prompts.excalidraw,
            this.t("placeholderExcalidrawPrompt"),
        );
        const htmlPromptInput = this.createTextArea(
            this.settings.artifact.prompts.html,
            this.t("placeholderHtmlPrompt"),
        );

        const debounceInput = document.createElement("input");
        debounceInput.type = "number";
        debounceInput.className = "b3-text-field fn__block";
        debounceInput.value = String(this.settings.binding.debounceMs);

        const autoAnalyzeInput = document.createElement("input");
        autoAnalyzeInput.type = "checkbox";
        autoAnalyzeInput.checked = this.settings.binding.autoAnalyzeOnTransaction;

        this.setting = new Setting({
            confirmCallback: async () => {
                this.settings = {
                    llm: {
                        provider: "openai-compatible",
                        baseUrl: baseUrlInput.value.trim(),
                        model: modelInput.value.trim(),
                        apiKey: apiKeyInput.value.trim(),
                        timeoutMs: this.settings.llm.timeoutMs,
                    },
                    artifact: {
                        model: artifactModelInput.value.trim(),
                        imageModel: this.settings.artifact.imageModel,
                        imagePrompt: this.settings.artifact.imagePrompt,
                        prompts: {
                            mermaid: mermaidPromptInput.value.trim(),
                            tikz: tikzPromptInput.value.trim(),
                            excalidraw: excalidrawPromptInput.value.trim(),
                            html: htmlPromptInput.value.trim(),
                        },
                    },
                    agent: {
                        model: agentModelInput.value.trim(),
                        systemPrompt: agentSystemPromptInput.value.trim(),
                        maxTurns: Number(agentTurnsInput.value) || 6,
                        enabledTools: Array.from(toolToggles.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
                            .filter((item) => item.checked)
                            .map((item) => item.value),
                        skills: this.settings.agent.skills,
                        promptPresets: this.settings.agent.promptPresets,
                        mcpServers: this.parseMcpServers(mcpServersInput.value),
                    },
                    binding: {
                        debounceMs: Number(debounceInput.value) || 650,
                        autoAnalyzeOnTransaction: autoAnalyzeInput.checked,
                    },
                    visual: this.settings.visual,
                };
                await this.persistSettings();
                showMessage(this.t("settingsSaved"));
                this.renderDock();
            },
        });
        this.setting.addItem({
            title: this.t("settingsBaseUrl"),
            direction: "row",
            createActionElement: () => baseUrlInput,
        });
        this.setting.addItem({
            title: this.t("settingsModel"),
            direction: "row",
            createActionElement: () => modelInput,
        });
        this.setting.addItem({
            title: this.t("settingsApiKey"),
            direction: "row",
            createActionElement: () => apiKeyInput,
        });
        this.setting.addItem({
            title: this.t("settingsArtifactModel"),
            direction: "row",
            createActionElement: () => artifactModelInput,
        });
        this.setting.addItem({
            title: this.t("settingsAgentModel"),
            direction: "row",
            createActionElement: () => agentModelInput,
        });
        this.setting.addItem({
            title: this.t("settingsSystemPrompt"),
            direction: "column",
            createActionElement: () => agentSystemPromptInput,
        });
        this.setting.addItem({
            title: this.t("settingsAgentTurns"),
            direction: "row",
            createActionElement: () => agentTurnsInput,
        });
        this.setting.addItem({
            title: this.t("settingsTools"),
            direction: "column",
            createActionElement: () => toolToggles,
        });
        this.setting.addItem({
            title: this.t("settingsMcpServers"),
            direction: "column",
            createActionElement: () => mcpServersInput,
        });
        this.setting.addItem({
            title: this.t("settingsMermaidPrompt"),
            direction: "column",
            createActionElement: () => mermaidPromptInput,
        });
        this.setting.addItem({
            title: this.t("settingsTikzPrompt"),
            direction: "column",
            createActionElement: () => tikzPromptInput,
        });
        this.setting.addItem({
            title: this.t("settingsExcalidrawPrompt"),
            direction: "column",
            createActionElement: () => excalidrawPromptInput,
        });
        this.setting.addItem({
            title: this.t("settingsHtmlPrompt"),
            direction: "column",
            createActionElement: () => htmlPromptInput,
        });
        this.setting.addItem({
            title: this.t("settingsDebounceMs"),
            direction: "row",
            createActionElement: () => debounceInput,
        });
        this.setting.addItem({
            title: this.t("settingsAutoAnalyze"),
            direction: "row",
            createActionElement: () => autoAnalyzeInput,
        });
        this.setting.open(this.t("pluginName"));
    }

    private createTextArea(value: string, placeholder = ""): HTMLTextAreaElement {
        const el = document.createElement("textarea");
        el.className = "b3-text-field fn__block tgai-textarea";
        el.value = value;
        el.placeholder = placeholder;
        el.rows = 8;
        return el;
    }

    private createToolToggleGroup(): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "tgai-tool-grid";
        const definitions = getNativeToolDefinitions(this.settings);
        wrap.innerHTML = definitions.map((tool) => `
            <label class="tgai-tool-toggle">
                <input type="checkbox" value="${this.escapeHtml(tool.id)}" ${tool.enabled ? "checked" : ""}>
                <span>${this.escapeHtml(this.getToolLabel(tool.id, tool.title))}</span>
            </label>
        `).join("");
        return wrap;
    }

    private getChatModelOptions(): string[] {
        const candidates = [
            this.settings.agent.model.trim(),
            this.settings.llm.model.trim(),
            this.settings.artifact.model.trim(),
        ].filter(Boolean);
        return Array.from(new Set(candidates.length > 0 ? candidates : [this.settings.llm.model.trim() || "gpt-4o-mini"]));
    }

    private getActiveChatModel(): string {
        return this.settings.agent.model.trim()
            || this.settings.llm.model.trim()
            || this.settings.artifact.model.trim()
            || "gpt-4o-mini";
    }

    private getNextChatModel(): string {
        const models = this.getChatModelOptions();
        if (models.length === 0) {
            return this.getActiveChatModel();
        }
        const current = this.getActiveChatModel();
        const index = models.indexOf(current);
        return models[(index + 1 + models.length) % models.length] || models[0];
    }

    private getToolLabel(toolId: string, fallback: string): string {
        const labels: Record<string, string> = {
            "siyuan.read_current_block": "toolReadCurrentBlock",
            "siyuan.get_block_attrs": "toolGetBlockAttrs",
            "siyuan.get_block_kramdown": "toolGetBlockKramdown",
            "siyuan.update_block": "toolUpdateBlock",
            "siyuan.insert_after_current_block": "toolInsertAfterCurrentBlock",
            "siyuan.append_to_document": "toolAppendToDocument",
            "siyuan.create_doc_with_md": "toolCreateDocWithMarkdown",
            "siyuan.set_block_attrs": "toolSetBlockAttrs",
        };
        const key = labels[toolId];
        return key ? this.t(key) : fallback;
    }

    private parseMcpServers(raw: string): TianGongSettings["agent"]["mcpServers"] {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    private renderConversationMessages(messages: ChatMessage[]): string {
        const startIndex = Math.max(0, messages.length - 24);
        return messages.slice(startIndex).map((message, offset) => this.renderChatMessage(message, startIndex + offset)).join("");
    }

    private renderChatMessage(message: ChatMessage, index = -1): string {
        const role = this.escapeHtml(message.role);
        const text = this.escapeHtml(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
        const actions = message.role === "assistant" && index >= 0
            ? `
                <div class="tgai-msg__actions">
                    <button class="tgai-msg__action" data-message-action="insert-after" data-message-index="${index}">${this.t("buttonInsertAfter")}</button>
                    <button class="tgai-msg__action" data-message-action="append-doc" data-message-index="${index}">${this.t("buttonAppendDocument")}</button>
                    <button class="tgai-msg__action" data-message-action="create-subdoc" data-message-index="${index}">${this.t("buttonCreateSubDoc")}</button>
                </div>`
            : "";
        return `
            <div class="tgai-msg tgai-msg--${role}">
                <div class="tgai-msg__role">${role}</div>
                <div class="tgai-msg__body">${text.replaceAll("\n", "<br>")}</div>
                ${actions}
            </div>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }

    private escapeRegExp(text: string): string {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    private getActiveConversation(): ChatConversation {
        const activeId = this.runtime.chat.activeConversationId || "default";
        let conversation = this.runtime.chat.conversations.find((item) => item.id === activeId);
        if (!conversation) {
            conversation = this.createConversation(activeId);
        }
        this.runtime.chat.activeConversationId = conversation.id;
        this.runtime.chat.activeSkillId = conversation.activeSkillId || this.runtime.chat.activeSkillId;
        this.runtime.chat.activePromptId = conversation.activePromptId || this.runtime.chat.activePromptId;
        this.runtime.chat.messages = conversation.messages;
        return conversation;
    }

    private getConversationDisplayTitle(conversation: ChatConversation): string {
        return conversation.id === "default" ? this.t("conversationDefault") : conversation.title;
    }

    private getConversationSubtitle(conversation: ChatConversation): string {
        const totalMessages = conversation.messages.filter((item) => item.role !== "system").length;
        const updatedAt = new Date(conversation.updatedAt);
        return `${this.tf("conversationMessageCount", {count: totalMessages})} · ${updatedAt.toLocaleString()}`;
    }

    private renderConversationMenu(activeConversationId: string): string {
        const conversations = [...this.runtime.chat.conversations]
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, 8);
        if (conversations.length === 0) {
            return `<div class="tgai-menu__group">
                <div class="tgai-menu__group-title">${this.escapeHtml(this.t("conversationRecent"))}</div>
                <div class="tgai-menu__empty">${this.escapeHtml(this.t("emptyList"))}</div>
            </div>`;
        }
        return `<div class="tgai-menu__group">
            <div class="tgai-menu__group-title">${this.escapeHtml(this.t("conversationRecent"))}</div>
            <div class="tgai-menu__conversation-list">
                ${conversations.map((item) => `
                    <button
                        type="button"
                        class="tgai-menu__conversation${item.id === activeConversationId ? " is-active" : ""}"
                        data-action="conversation-select"
                        data-conversation-id="${this.escapeHtml(item.id)}"
                    >
                        <span class="tgai-menu__conversation-title">${this.escapeHtml(this.getConversationDisplayTitle(item))}</span>
                        <span class="tgai-menu__conversation-subtitle">${this.escapeHtml(this.getConversationSubtitle(item))}</span>
                    </button>
                `).join("")}
            </div>
        </div>`;
    }

    private createConversation(id = `conv-${Date.now()}`): ChatConversation {
        const title = id === "default"
            ? this.t("conversationDefault")
            : `${this.t("conversationTitle")} ${this.runtime.chat.conversations.length + 1}`;
        const conversation: ChatConversation = {
            id,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
            activePromptId: this.runtime.chat.activePromptId || "default",
            activeSkillId: this.runtime.chat.activeSkillId || "chat",
        };
        this.runtime.chat.conversations = [conversation, ...this.runtime.chat.conversations.filter((item) => item.id !== id)];
        this.runtime.chat.activeConversationId = conversation.id;
        this.runtime.chat.activeSkillId = conversation.activeSkillId;
        this.runtime.chat.activePromptId = conversation.activePromptId;
        this.runtime.chat.messages = conversation.messages;
        return conversation;
    }

    private setActiveConversation(id: string): void {
        let conversation = this.runtime.chat.conversations.find((item) => item.id === id);
        if (!conversation) {
            conversation = this.createConversation(id);
        }
        this.runtime.chat.activeConversationId = conversation.id;
        this.runtime.chat.activePromptId = conversation.activePromptId;
        this.runtime.chat.activeSkillId = conversation.activeSkillId;
        this.runtime.chat.messages = conversation.messages;
    }

    private showConversationHistory(): void {
        const list = this.runtime.chat.conversations
            .map((item) => `${this.getConversationDisplayTitle(item)} · ${new Date(item.updatedAt).toLocaleString()}`)
            .join("\n");
        showMessage(list || this.t("emptyList"));
    }

    private getActivePrompt(): TianGongSettings["agent"]["promptPresets"][number] {
        return this.settings.agent.promptPresets.find((item) => item.id === this.runtime.chat.activePromptId)
            || this.settings.agent.promptPresets[0]
            || {
                id: "default",
                name: "Default",
                content: "",
                createdAt: Date.now(),
            };
    }

    private async savePromptFromInput(content: string): Promise<void> {
        if (!content) {
            showMessage(this.t("promptEmpty"));
            return;
        }
        const now = Date.now();
        const name = content.split(/\r?\n/)[0].trim().slice(0, 18) || this.t("promptUntitled");
        const id = this.createPromptId();
        this.settings.agent.promptPresets = [
            ...this.settings.agent.promptPresets,
            {id, name, content, createdAt: now},
        ];
        this.runtime.chat.activePromptId = id;
        await this.persistSettings();
        await this.persistRuntime();
        this.renderDock();
        showMessage(this.t("promptSaved"));
    }

    private createPromptId(): string {
        return `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    private async refreshCurrentTabContext(notify = false): Promise<string> {
        const blockId = this.getCurrentEditorBlockId();
        if (!blockId) {
            return "";
        }
        const kramdown = await getBlockKramdown(blockId);
        this.runtime.chat.contextPreview = kramdown.replace(/\s+/g, " ").trim();
        await this.persistRuntime();
        this.renderDock();
        if (notify) {
            showMessage(this.t("contextLoaded"));
        }
        return kramdown;
    }

    private async buildContextualUserMessage(userText: string): Promise<string> {
        if (!this.runtime.chat.includeCurrentTab) {
            return userText;
        }
        const context = await this.refreshCurrentTabContext(false);
        if (!context.trim()) {
            return userText;
        }
        return [
            userText,
            "",
            "[Current SiYuan tab content]",
            context.slice(0, 12000),
        ].join("\n");
    }

    private async sendChatMessage(userText: string): Promise<void> {
        const conversation = this.getActiveConversation();
        conversation.activeSkillId = this.runtime.chat.activeSkillId;
        conversation.activePromptId = this.runtime.chat.activePromptId;
        const skill = getSkill(this.settings, conversation.activeSkillId);
        try {
            const history = conversation.messages.filter((item) => item.role !== "system");
            const prompt = this.getActivePrompt();
            const contextualUserText = await this.buildContextualUserMessage(userText);
            conversation.messages.push({role: "user", content: userText});
            conversation.updatedAt = Date.now();
            this.runtime.chat.messages = conversation.messages;
            await this.persistRuntime();
            this.renderDock();
            const result = await runAgentTurn(
                this.settings,
                skill.id,
                history,
                contextualUserText,
                {
                    currentBlockId: () => this.getCurrentEditorBlockId(),
                    currentDocId: () => this.getCurrentEditorDocId(),
                },
                prompt.content,
            );
            const visibleMessages = result.messages.filter((item) => item.role !== "system");
            const lastUser = visibleMessages.map((item) => item.role).lastIndexOf("user");
            if (lastUser >= 0) {
                visibleMessages[lastUser] = {role: "user", content: userText};
            }
            conversation.messages.length = 0;
            conversation.messages.push(...visibleMessages);
            conversation.updatedAt = Date.now();
            this.runtime.chat.messages = conversation.messages;
            await this.persistRuntime();
            this.renderDock();
        } catch (error) {
            showMessage(error instanceof Error ? error.message : String(error));
        }
    }

    private getCurrentEditorBlockId(): string {
        const editor = getAllEditor()[0];
        if (!editor?.protyle?.block?.rootID) {
            showMessage(this.t("pleaseOpenDocument"));
            return "";
        }
        return editor.protyle.block.rootID;
    }

    private getCurrentEditorDocId(): string {
        const editor = getAllEditor()[0];
        if (!editor?.protyle?.block?.rootID) {
            showMessage(this.t("pleaseOpenDocument"));
            return "";
        }
        return editor.protyle.block.rootID;
    }

    private getMenuBlockId(blockElements: HTMLElement[]): string {
        for (let i = blockElements.length - 1; i >= 0; i--) {
            const blockId = blockElements[i]?.dataset.nodeId || "";
            if (blockId) {
                return blockId;
            }
        }
        return "";
    }

    private buildArtifactFingerprint(format: ArtifactFormat, sourceText: string, targetText: string, imageUrls: string[]): string {
        return this.fingerprint([
            format,
            this.settings.llm.model,
            sourceText,
            targetText,
            imageUrls.join("\u0001"),
        ].join("\u0002"));
    }

    private fingerprint(text: string): string {
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    }

    private async persistSettings(): Promise<void> {
        await this.saveData(SETTINGS_STORAGE, this.settings);
    }

    private async persistRuntime(): Promise<void> {
        await this.saveData(RUNTIME_STORAGE, this.runtime);
    }

    private async probeLLM(): Promise<void> {
        const result = await probeLLM(this.settings);
        showMessage(result.ok ? this.t("serviceReady") : result.message);
    }

    private scheduleRefresh(rootIDs: string[]): void {
        if (this.scanTimer) {
            window.clearTimeout(this.scanTimer);
        }
        this.scanTimer = window.setTimeout(() => {
            void this.processRootChanges(rootIDs);
        }, this.settings.binding.debounceMs);
    }

    private async processRootChanges(rootIDs: string[]): Promise<void> {
        await this.scanBlocks(rootIDs);
        await this.refreshArtifactsForRoots(rootIDs);
    }

    private async scanBlocks(rootIDs: string[]): Promise<void> {
        for (const rootID of Array.from(new Set(rootIDs))) {
            try {
                const attrs = await getBlockAttrs(rootID);
                if (attrs[this.settings.visual.imageTargetKey]) {
                    const targetAttrs = await getBlockAttrs(attrs[this.settings.visual.imageTargetKey]);
                    this.runtime.bindings[rootID] = {
                        sourceId: rootID,
                        targetId: attrs[this.settings.visual.imageTargetKey],
                        targetTitle: targetAttrs.title || "",
                        updatedAt: Date.now(),
                    };
                }
                const kramdown = await getBlockKramdown(rootID);
                const imageSources = extractImageSources(kramdown);
                if (imageSources.length > 0) {
                    const resolved = normalizeAssetUrl(imageSources[0]);
                    this.runtime.analyses[rootID] = {
                        blockId: rootID,
                        kind: "image-candidate",
                        summary: resolved,
                        tags: ["image"],
                        updatedAt: Date.now(),
                    };
                }
            } catch {
                // ignore transient transaction races
            }
        }
        await this.persistRuntime();
        this.renderDock();
    }

    private async bindToTarget(sourceId: string): Promise<void> {
        if (!this.runtime.lastTargetId) {
            showMessage(this.t("markTargetFirst"));
            return;
        }
        await this.snapshotBlockState(sourceId, [this.settings.visual.imageTargetKey, this.settings.visual.bindingKey], false);
        const targetAttrs = await getBlockAttrs(this.runtime.lastTargetId);
        const bindingPayload = {
            sourceId,
            targetId: this.runtime.lastTargetId,
            targetTitle: targetAttrs.title || "",
            updatedAt: Date.now(),
        };
        await setBlockAttrs(sourceId, {
            [this.settings.visual.imageTargetKey]: this.runtime.lastTargetId,
            [this.settings.visual.bindingKey]: JSON.stringify(bindingPayload),
        });
        this.runtime.bindings[sourceId] = bindingPayload;
        await this.persistRuntime();
        this.renderDock();
        showMessage(this.tf("boundTarget", {sourceId, targetId: this.runtime.lastTargetId}));
    }

    private async analyzeBlock(blockId: string): Promise<void> {
        await this.snapshotBlockState(blockId, ["memo"], false);
        const attrs = await getBlockAttrs(blockId);
        const kramdown = await getBlockKramdown(blockId);
        const imageSources = extractImageSources(kramdown);
        const result = imageSources.length > 0
            ? await analyzeImageBlock(this.settings, normalizeAssetUrl(imageSources[0]), kramdown)
            : await analyzeTextBlock(this.settings, kramdown);

        await setBlockAttrs(blockId, {
            memo: this.mergeAnalysisMemo(attrs.memo || "", result.kind, result.summary, result.tags),
        });
        this.runtime.analyses[blockId] = {
            blockId,
            kind: result.kind,
            summary: result.summary,
            tags: result.tags,
            updatedAt: Date.now(),
        };
        await this.persistRuntime();
        this.renderDock();
        showMessage(this.t("analysisSaved"));
    }

    private async generateImageBlock(blockId: string): Promise<void> {
        if (!blockId) {
            showMessage(this.t("noTargetBlock"));
            return;
        }
        try {
            const sourceKramdown = await getBlockKramdown(blockId);
            const result = await generateImage(this.settings, sourceKramdown);
            const fileName = `tgai-${blockId}-${Date.now()}.png`;
            const assetPath = await uploadAsset(fileName, result.blob);
            await insertBlock(`![${this.t("generatedImageAlt")}](${assetPath})`, blockId);
            showMessage(this.t("imageGenerated"));
        } catch (error) {
            showMessage(this.tf("imageGenerateFailed", {
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }

    private mergeAnalysisMemo(existingMemo: string, kind: string, summary: string, tags: string[]): string {
        const start = "[TianGong AI Analysis]";
        const end = "[/TianGong AI Analysis]";
        const memo = [
            start,
            `Kind: ${kind || "analysis"}`,
            `Summary: ${summary || ""}`,
            `Tags: ${tags.length > 0 ? tags.join(", ") : "none"}`,
            `Time: ${new Date().toLocaleString()}`,
            end,
        ].join("\n");
        const pattern = new RegExp(`${this.escapeRegExp(start)}[\\s\\S]*?${this.escapeRegExp(end)}`);
        const trimmed = existingMemo.trim();
        if (pattern.test(trimmed)) {
            return trimmed.replace(pattern, memo);
        }
        return [trimmed, memo].filter(Boolean).join("\n\n");
    }

    private async createArtifact(sourceId: string, format: ArtifactFormat): Promise<void> {
        if (!sourceId) {
            showMessage(this.t("noTargetBlock"));
            return;
        }
        showMessage(this.tf("artifactGenerating", {format}));
        try {
            const artifactId = await this.generateOrUpdateArtifact(sourceId, format);
            if (artifactId) {
                showMessage(this.tf("artifactSaved", {format}));
            }
        } catch (error) {
            showMessage(this.tf("artifactGenerateFailed", {
                format,
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }

    private async refreshArtifactsForSource(sourceId: string): Promise<void> {
        const linked = Object.values(this.runtime.artifacts).filter((item) => item.sourceId === sourceId);
        for (const artifact of linked) {
            await this.generateOrUpdateArtifact(artifact.sourceId, artifact.format, artifact.blockId);
        }
        if (linked.length > 0) {
            showMessage(this.tf("refreshedArtifacts", {count: linked.length}));
        }
    }

    private async refreshArtifactsForRoots(rootIDs: string[]): Promise<void> {
        const matchedRootIDs = new Set(rootIDs.filter(Boolean));
        if (matchedRootIDs.size === 0) {
            return;
        }
        const artifacts = Object.values(this.runtime.artifacts).filter((item) =>
            matchedRootIDs.has(item.sourceId) || matchedRootIDs.has(item.targetId)
        );
        for (const artifact of artifacts) {
            try {
                await this.generateOrUpdateArtifact(artifact.sourceId, artifact.format, artifact.blockId, true);
            } catch {
                // keep background refresh non-blocking
            }
        }
    }

    private async generateOrUpdateArtifact(
        sourceId: string,
        format: ArtifactFormat,
        artifactBlockId = "",
        silent = false,
    ): Promise<string> {
        const sourceKramdown = await getBlockKramdown(sourceId);
        const sourceAttrs = await getBlockAttrs(sourceId);
        const targetId = sourceAttrs[this.settings.visual.imageTargetKey]
            || this.runtime.artifacts[artifactBlockId]?.targetId
            || this.runtime.bindings[sourceId]?.targetId
            || this.runtime.lastTargetId
            || "";
        const targetKramdown = targetId ? await getBlockKramdown(targetId) : "";
        const imageUrls = extractImageSources(sourceKramdown).map((src) => normalizeAssetUrl(src));
        const fingerprint = this.buildArtifactFingerprint(format, sourceKramdown, targetKramdown, imageUrls);
        const existingArtifact = artifactBlockId ? this.runtime.artifacts[artifactBlockId] : undefined;
        if (existingArtifact && existingArtifact.fingerprint === fingerprint) {
            return artifactBlockId;
        }
        const artifact = await generateArtifact(this.settings, format, sourceKramdown, targetKramdown, imageUrls);
        const markdown = this.buildArtifactMarkdown(format, artifact.content);

        let blockId = artifactBlockId;
        if (blockId) {
            await this.snapshotBlockState(blockId, [
                this.settings.visual.artifactSourceKey,
                this.settings.visual.artifactTargetKey,
                this.settings.visual.artifactFormatKey,
            ], true);
            await updateBlock(blockId, markdown);
        } else {
            blockId = await insertBlock(markdown, sourceId);
        }
        if (!blockId) {
            throw new Error("artifact block creation failed");
        }

        await setBlockAttrs(blockId, {
            [this.settings.visual.artifactSourceKey]: sourceId,
            [this.settings.visual.artifactTargetKey]: targetId,
            [this.settings.visual.artifactFormatKey]: format,
        });

        this.runtime.artifacts[blockId] = {
            blockId,
            sourceId,
            targetId,
            format,
            summary: artifact.summary,
            markdown,
            fingerprint,
            updatedAt: Date.now(),
        };
        await this.persistRuntime();
        this.renderDock();
        if (!silent) {
            showMessage(this.tf("artifactUpdated", {format}));
        }
        return blockId;
    }

    private buildArtifactMarkdown(format: ArtifactFormat, content: string): string {
        if (format === "mermaid") {
            return `\`\`\`mermaid\n${content.trim()}\n\`\`\``;
        }
        if (format === "tikz") {
            return `\`\`\`tex\n${content.trim()}\n\`\`\``;
        }
        if (format === "html") {
            return content.trim();
        }
        return `\`\`\`json\n${content.trim()}\n\`\`\``;
    }

    private bindMessageActionButtons(): void {
        this.dockElement?.querySelectorAll<HTMLElement>("[data-message-action]").forEach((button) => {
            button.addEventListener("click", async () => {
                const index = Number(button.dataset.messageIndex || "-1");
                const action = button.dataset.messageAction || "";
                const message = this.runtime.chat.messages[index];
                if (!message || message.role !== "assistant") {
                    return;
                }
                const text = this.getMessageText(message);
                if (!text.trim()) {
                    return;
                }
                if (action === "insert-after") {
                    await this.insertTextAfterCurrentBlock(text);
                } else if (action === "append-doc") {
                    await this.appendTextToCurrentDocument(text);
                } else if (action === "create-subdoc") {
                    await this.createSubdocumentFromText(text);
                }
            });
        });
    }

    private getMessageText(message: ChatMessage): string {
        if (typeof message.content === "string") {
            return message.content;
        }
        return JSON.stringify(message.content, null, 2);
    }

    private async insertTextAfterCurrentBlock(text: string): Promise<void> {
        const blockId = this.getCurrentEditorBlockId();
        if (!blockId) {
            return;
        }
        await insertBlock(text, blockId);
        showMessage(this.t("messageInserted"));
    }

    private async appendTextToCurrentDocument(text: string): Promise<void> {
        const docId = this.getCurrentEditorDocId();
        if (!docId) {
            return;
        }
        await appendBlock(text, docId);
        showMessage(this.t("messageAppended"));
    }

    private async createSubdocumentFromText(text: string): Promise<void> {
        const docId = this.getCurrentEditorDocId();
        if (!docId) {
            return;
        }
        const [hPath, pathInfo] = await Promise.all([getHPathByID(docId), getPathByID(docId)]);
        if (!hPath || !pathInfo.notebook) {
            showMessage(this.t("noTargetBlock"));
            return;
        }
        const title = this.buildSubdocumentTitle(text);
        const basePath = this.buildSubdocumentPath(hPath, title);
        const uniquePath = await this.ensureUniqueDocumentPath(getIDsByHPath, pathInfo.notebook, basePath);
        const createdId = await createDocWithMd(pathInfo.notebook, uniquePath, text.trim());
        if (createdId) {
            showMessage(this.t("subdocCreated"));
        }
    }

    private async ensureUniqueDocumentPath(
        getIDsByHPathFn: (path: string, notebook: string) => Promise<string[]>,
        notebook: string,
        path: string,
    ): Promise<string> {
        const existing = await getIDsByHPathFn(path, notebook);
        if (existing.length === 0) {
            return path;
        }
        return `${path}-${Date.now().toString(36).slice(-6)}`;
    }

    private buildSubdocumentTitle(text: string): string {
        const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) || "";
        return firstLine
            .replace(/^#{1,6}\s*/, "")
            .replace(/^[-*+]\s+/, "")
            .replace(/[\\/:*?"<>|]/g, "-")
            .trim()
            .slice(0, 48) || `TianGong-${Date.now().toString().slice(-6)}`;
    }

    private buildSubdocumentPath(parentPath: string, title: string): string {
        const normalizedParent = parentPath && parentPath !== "/" ? parentPath.replace(/\/+$/g, "") : "";
        return `${normalizedParent || ""}/${title}`.replace(/\/+/g, "/").replace(/^$/, "/");
    }

    private async snapshotBlockState(blockId: string, keys: string[], includeMarkdown: boolean): Promise<void> {
        const attrs = await getBlockAttrs(blockId);
        const snapshot: AttrSnapshot = {
            blockId,
            reason: keys.join(","),
            createdAt: Date.now(),
            attrs: {},
        };
        if (includeMarkdown) {
            snapshot.markdown = await getBlockKramdown(blockId);
        }
        for (const key of keys) {
            snapshot.attrs[key] = typeof attrs[key] === "string" ? attrs[key] : "";
        }
        this.runtime.snapshots.unshift(snapshot);
        this.runtime.snapshots = this.runtime.snapshots.slice(0, 32);
        await this.persistRuntime();
    }

    private async restoreLastSnapshot(blockId: string): Promise<void> {
        if (!blockId) {
            showMessage(this.t("noTargetBlock"));
            return;
        }
        const snapshotIndex = this.runtime.snapshots.findIndex((item) => item.blockId === blockId);
        if (snapshotIndex < 0) {
            showMessage(this.t("snapshotNotFound"));
            return;
        }
        const snapshot = this.runtime.snapshots[snapshotIndex];
        if (typeof snapshot.markdown === "string") {
            await updateBlock(blockId, snapshot.markdown);
        }
        await setBlockAttrs(blockId, snapshot.attrs);
        this.runtime.snapshots.splice(snapshotIndex, 1);
        await this.persistRuntime();
        this.renderDock();
        showMessage(this.tf("restored", {id: blockId}));
    }
}

