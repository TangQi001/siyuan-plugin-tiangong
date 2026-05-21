export type LLMProvider = "openai-compatible";

export type ToolScope = "read" | "write" | "network" | "mcp";

export interface ToolDefinition {
    id: string;
    title: string;
    description: string;
    scope: ToolScope;
    readOnly: boolean;
    destructive: boolean;
    enabled: boolean;
    inputSchema?: Record<string, any>;
    serverId?: string;
    toolName?: string;
}

export interface SkillPreset {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    modelOverride: string;
    enabledTools: string[];
}

export interface PromptPreset {
    id: string;
    name: string;
    content: string;
    createdAt: number;
}

export interface McpServerConfig {
    id: string;
    name: string;
    transport: "stdio" | "streamable-http";
    command: string;
    args: string[];
    url: string;
    enabled: boolean;
    allowTools: string[];
}

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | any[];
    toolName?: string;
    toolCallId?: string;
    toolCalls?: any[];
}

export interface ChatConversation {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ChatMessage[];
    activePromptId: string;
    activeSkillId: string;
}

export interface TianGongSettings {
    llm: {
        provider: LLMProvider;
        baseUrl: string;
        model: string;
        apiKey: string;
        timeoutMs: number;
    };
    artifact: {
        model: string;
        imageModel: string;
        imagePrompt: string;
        prompts: Record<ArtifactFormat, string>;
    };
    agent: {
        model: string;
        systemPrompt: string;
        maxTurns: number;
        enabledTools: string[];
        skills: SkillPreset[];
        promptPresets: PromptPreset[];
        mcpServers: McpServerConfig[];
    };
    binding: {
        autoAnalyzeOnTransaction: boolean;
        debounceMs: number;
    };
    visual: {
        imageTargetKey: string;
        bindingKey: string;
        artifactSourceKey: string;
        artifactTargetKey: string;
        artifactFormatKey: string;
    };
}

export interface AttrSnapshot {
    blockId: string;
    attrs: Record<string, string>;
    reason: string;
    createdAt: number;
    markdown?: string;
}

export type ArtifactFormat = "mermaid" | "tikz" | "excalidraw" | "html";

export interface GeneratedArtifact {
    blockId: string;
    sourceId: string;
    targetId: string;
    format: ArtifactFormat;
    summary: string;
    markdown: string;
    fingerprint: string;
    updatedAt: number;
}

export interface TianGongRuntime {
    lastTargetId: string;
    recentRootIDs: string[];
    chat: {
        activeConversationId: string;
        activeSkillId: string;
        activePromptId: string;
        includeCurrentTab: boolean;
        contextPreview: string;
        conversations: ChatConversation[];
        messages: ChatMessage[];
    };
    snapshots: AttrSnapshot[];
    bindings: Record<string, {
        sourceId: string;
        targetId: string;
        targetTitle: string;
        updatedAt: number;
    }>;
    analyses: Record<string, {
        blockId: string;
        kind: string;
        summary: string;
        tags: string[];
        updatedAt: number;
    }>;
    artifacts: Record<string, GeneratedArtifact>;
}

export interface BlockAttrsResponse {
    code: number;
    msg: string;
    data: Record<string, string>;
}

export interface KramdownResponse {
    code: number;
    msg: string;
    data: {
        id: string;
        kramdown: string;
    };
}

export interface ApiResponse<T> {
    code: number;
    msg: string;
    data: T;
}
