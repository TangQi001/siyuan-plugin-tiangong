import type {TianGongRuntime, TianGongSettings} from "./types";
import {safeJsonParse} from "./api";

export const DEFAULT_ARTIFACT_PROMPTS = {
    mermaid: [
        "You are generating an editable Mermaid diagram for SiYuan notes.",
        "Use the selected block content as the only primary source.",
        "Return Mermaid syntax only, without triple backticks or prose.",
        "Prefer concise node labels and clear directional relationships.",
        "",
        "Selected block content:",
        "{sourceText}",
        "",
        "Reference block content, if any:",
        "{targetText}",
    ].join("\n"),
    tikz: [
        "You are generating an editable TikZ diagram for an academic note.",
        "Return only a single tikzpicture environment.",
        "Do not include documentclass, package imports, or explanations.",
        "",
        "Selected block content:",
        "{sourceText}",
        "",
        "Reference block content, if any:",
        "{targetText}",
    ].join("\n"),
    excalidraw: [
        "You are generating an Excalidraw scene JSON for later import.",
        "Return JSON only. Use rectangles, arrows, and text elements.",
        "",
        "Selected block content:",
        "{sourceText}",
        "",
        "Reference block content, if any:",
        "{targetText}",
    ].join("\n"),
    html: [
        "You are generating a self-contained HTML block for SiYuan notes.",
        "Return HTML only, without Markdown fences or prose.",
        "Wrap the content in a single <div> element so it can be used as an HTML block.",
        "If you need vector graphics, prefer inline SVG inside the wrapper div.",
        "Avoid external assets, scripts, and unsafe inline behavior.",
        "",
        "Selected block content:",
        "{sourceText}",
        "",
        "Reference block content, if any:",
        "{targetText}",
    ].join("\n"),
};

export const DEFAULT_IMAGE_PROMPT = [
    "Create a clean, note-friendly illustration based on the selected SiYuan block.",
    "Prefer clear subject structure, readable composition, and no embedded text unless explicitly required.",
    "",
    "Selected block content:",
    "{sourceText}",
].join("\n");

export const DEFAULT_SKILLS: TianGongSettings["agent"]["skills"] = [
    {
        id: "chat",
        name: "对话",
        description: "结合当前文档和选中内容进行通用对话。",
        systemPrompt: "你是运行在思源笔记中的简洁助手。",
        modelOverride: "",
        enabledTools: [
            "siyuan.read_current_block",
            "siyuan.get_block_attrs",
            "siyuan.get_block_kramdown",
            "siyuan.update_block",
            "siyuan.insert_after_current_block",
            "siyuan.append_to_document",
            "siyuan.create_doc_with_md",
            "mcp",
        ],
    },
    {
        id: "summarize",
        name: "摘要",
        description: "总结内容并写回当前块。",
        systemPrompt: "请总结提供的内容，并输出简洁结构。",
        modelOverride: "",
        enabledTools: ["siyuan.read_current_block", "siyuan.update_block", "siyuan.get_block_attrs"],
    },
    {
        id: "diagram",
        name: "图表",
        description: "生成 Mermaid、TikZ、Excalidraw 或 HTML 图形内容。",
        systemPrompt: "请根据选中内容生成准确、可编辑、可直接插入思源的图形产物。",
        modelOverride: "",
        enabledTools: ["siyuan.read_current_block", "siyuan.get_block_attrs", "siyuan.insert_after_current_block"],
    },
];

export const DEFAULT_PROMPT_PRESETS: TianGongSettings["agent"]["promptPresets"] = [
    {
        id: "default",
        name: "默认对话",
        content: "请用简洁、准确、可执行的方式回答，并优先结合当前页签内容。",
        createdAt: Date.now(),
    },
    {
        id: "note-editor",
        name: "笔记整理",
        content: "把当前页签内容整理成更清晰的笔记结构，必要时给出可直接插入的改写版本。",
        createdAt: Date.now(),
    },
    {
        id: "workflow",
        name: "工作流助手",
        content: "像工作流助手一样推进任务，必要时调用工具，并把每一步结果说明清楚。",
        createdAt: Date.now(),
    },
];

export const DEFAULT_NATIVE_TOOLS = [
    "siyuan.read_current_block",
    "siyuan.get_block_attrs",
    "siyuan.get_block_kramdown",
    "siyuan.update_block",
    "siyuan.insert_after_current_block",
    "siyuan.append_to_document",
    "siyuan.create_doc_with_md",
] as const;

export const DEFAULT_SETTINGS: TianGongSettings = {
    llm: {
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        apiKey: "",
        timeoutMs: 30000,
    },
    artifact: {
        model: "",
        imageModel: "gpt-image-1",
        imagePrompt: DEFAULT_IMAGE_PROMPT,
        prompts: DEFAULT_ARTIFACT_PROMPTS,
    },
    agent: {
        model: "",
        systemPrompt: "你是运行在思源笔记中的助手，回答要简洁、准确，并优先服务于当前文档的编辑与整理。",
        maxTurns: 6,
        enabledTools: [...DEFAULT_NATIVE_TOOLS],
        skills: [...DEFAULT_SKILLS],
        promptPresets: [...DEFAULT_PROMPT_PRESETS],
        mcpServers: [],
    },
    binding: {
        autoAnalyzeOnTransaction: true,
        debounceMs: 650,
    },
    visual: {
        imageTargetKey: "custom-img2-target",
        bindingKey: "custom-tgai-binding",
        artifactSourceKey: "custom-tgai-source",
        artifactTargetKey: "custom-tgai-target",
        artifactFormatKey: "custom-tgai-format",
    },
};

const LEGACY_PROMPT_GARBLED_PATTERN = /[瀵硅瘽鎽樿鍥捐〃榛樿绗旇宸ヤ綔娴佺紪杈戞€濇簮]|锟|�/;
const LEGACY_AGENT_SYSTEM_PROMPT = "You are a helpful assistant operating inside SiYuan.";

function looksGarbled(text: string): boolean {
    return LEGACY_PROMPT_GARBLED_PATTERN.test(text);
}

function normalizeSkills(
    skills: TianGongSettings["agent"]["skills"] | undefined,
): TianGongSettings["agent"]["skills"] {
    if (!Array.isArray(skills)) {
        return [...DEFAULT_SKILLS];
    }
    const defaultsById = new Map(DEFAULT_SKILLS.map((item) => [item.id, item]));
    return skills.map((item) => {
        const fallback = defaultsById.get(item.id);
        if (!fallback) {
            return item;
        }
        const source = `${item.name}\n${item.description}\n${item.systemPrompt}`;
        if (looksGarbled(source) || item.systemPrompt === LEGACY_AGENT_SYSTEM_PROMPT) {
            return {
                ...item,
                name: fallback.name,
                description: fallback.description,
                systemPrompt: fallback.systemPrompt,
            };
        }
        return item;
    });
}

function normalizePromptPresets(
    presets: TianGongSettings["agent"]["promptPresets"] | undefined,
): TianGongSettings["agent"]["promptPresets"] {
    if (!Array.isArray(presets)) {
        return [...DEFAULT_PROMPT_PRESETS];
    }
    const defaultsById = new Map(DEFAULT_PROMPT_PRESETS.map((item) => [item.id, item]));
    return presets.map((item) => {
        const fallback = defaultsById.get(item.id);
        if (!fallback) {
            return item;
        }
        const source = `${item.name}\n${item.content}`;
        if (looksGarbled(source) || source.includes(LEGACY_AGENT_SYSTEM_PROMPT)) {
            return {
                ...item,
                name: fallback.name,
                content: fallback.content,
            };
        }
        return item;
    });
}

export const DEFAULT_RUNTIME: TianGongRuntime = {
    lastTargetId: "",
    recentRootIDs: [],
    chat: {
        activeConversationId: "default",
        activeSkillId: "chat",
        activePromptId: "default",
        includeCurrentTab: true,
        contextPreview: "",
        conversations: [],
        messages: [],
    },
    snapshots: [],
    bindings: {},
    analyses: {},
    artifacts: {},
};

export function mergeSettings(raw: unknown): TianGongSettings {
    const input = typeof raw === "string" ? safeJsonParse(raw, {}) : raw;
    const inputAgent = (input as Partial<TianGongSettings>)?.agent;
    return {
        llm: {
            ...DEFAULT_SETTINGS.llm,
            ...(input as Partial<TianGongSettings>)?.llm,
        },
        artifact: {
            ...DEFAULT_SETTINGS.artifact,
            ...(input as Partial<TianGongSettings>)?.artifact,
            imageModel: (input as Partial<TianGongSettings>)?.artifact?.imageModel || DEFAULT_SETTINGS.artifact.imageModel,
            imagePrompt: (input as Partial<TianGongSettings>)?.artifact?.imagePrompt || DEFAULT_SETTINGS.artifact.imagePrompt,
            prompts: {
                ...DEFAULT_SETTINGS.artifact.prompts,
                ...(input as Partial<TianGongSettings>)?.artifact?.prompts,
            },
        },
        agent: {
            ...DEFAULT_SETTINGS.agent,
            ...inputAgent,
            systemPrompt:
                typeof inputAgent?.systemPrompt === "string" &&
                inputAgent.systemPrompt.trim().length > 0 &&
                inputAgent.systemPrompt !== LEGACY_AGENT_SYSTEM_PROMPT &&
                !looksGarbled(inputAgent.systemPrompt)
                    ? inputAgent.systemPrompt
                    : DEFAULT_SETTINGS.agent.systemPrompt,
            enabledTools: Array.isArray(inputAgent?.enabledTools)
                ? inputAgent.enabledTools
                : [...DEFAULT_SETTINGS.agent.enabledTools],
            skills: normalizeSkills(inputAgent?.skills),
            promptPresets: normalizePromptPresets(inputAgent?.promptPresets),
            mcpServers: Array.isArray(inputAgent?.mcpServers)
                ? inputAgent.mcpServers
                : [...DEFAULT_SETTINGS.agent.mcpServers],
        },
        binding: {
            ...DEFAULT_SETTINGS.binding,
            ...(input as Partial<TianGongSettings>)?.binding,
        },
        visual: {
            ...DEFAULT_SETTINGS.visual,
            ...(input as Partial<TianGongSettings>)?.visual,
        },
    };
}

export function mergeRuntime(raw: unknown): TianGongRuntime {
    const input = typeof raw === "string" ? safeJsonParse(raw, {}) : raw;
    return {
        ...DEFAULT_RUNTIME,
        ...(input as Partial<TianGongRuntime>),
        bindings: {
            ...DEFAULT_RUNTIME.bindings,
            ...(input as Partial<TianGongRuntime>)?.bindings,
        },
        analyses: {
            ...DEFAULT_RUNTIME.analyses,
            ...(input as Partial<TianGongRuntime>)?.analyses,
        },
        artifacts: {
            ...DEFAULT_RUNTIME.artifacts,
            ...(input as Partial<TianGongRuntime>)?.artifacts,
        },
        snapshots: Array.isArray((input as Partial<TianGongRuntime>)?.snapshots)
            ? ((input as Partial<TianGongRuntime>)?.snapshots as any[])
            : [],
        recentRootIDs: Array.isArray((input as Partial<TianGongRuntime>)?.recentRootIDs)
            ? ((input as Partial<TianGongRuntime>)?.recentRootIDs as string[])
            : [],
        chat: {
            activeConversationId: (input as Partial<TianGongRuntime>)?.chat?.activeConversationId || "default",
            activeSkillId: (input as Partial<TianGongRuntime>)?.chat?.activeSkillId || "chat",
            activePromptId: (input as Partial<TianGongRuntime>)?.chat?.activePromptId || "default",
            includeCurrentTab: (input as Partial<TianGongRuntime>)?.chat?.includeCurrentTab ?? true,
            contextPreview: (input as Partial<TianGongRuntime>)?.chat?.contextPreview || "",
            conversations: Array.isArray((input as Partial<TianGongRuntime>)?.chat?.conversations)
                ? ((input as Partial<TianGongRuntime>)?.chat?.conversations as TianGongRuntime["chat"]["conversations"])
                : [],
            messages: Array.isArray((input as Partial<TianGongRuntime>)?.chat?.messages)
                ? ((input as Partial<TianGongRuntime>)?.chat?.messages as TianGongRuntime["chat"]["messages"])
                : [],
        },
    };
}
