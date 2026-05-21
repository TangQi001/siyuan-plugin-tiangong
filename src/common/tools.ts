import {
    appendBlock,
    createDocWithMd,
    getBlockAttrs,
    getBlockKramdown,
    getHPathByID,
    getIDsByHPath,
    getPathByID,
    insertBlock,
    setBlockAttrs,
    updateBlock,
} from "./api";
import {callMcpTool, listAllMcpTools, parseMcpToolFunctionName} from "./mcp";
import type {ToolDefinition, TianGongSettings} from "./types";

export const ALL_NATIVE_TOOL_IDS = [
    "siyuan.read_current_block",
    "siyuan.get_block_attrs",
    "siyuan.get_block_kramdown",
    "siyuan.update_block",
    "siyuan.insert_after_current_block",
    "siyuan.append_to_document",
    "siyuan.create_doc_with_md",
    "siyuan.set_block_attrs",
] as const;

export interface ToolExecutionContext {
    currentBlockId(): string;
    currentDocId(): string;
}

export interface ToolCallResult {
    content: string;
    structured?: any;
}

export function getNativeToolDefinitions(settings: TianGongSettings): ToolDefinition[] {
    const enabled = new Set(settings.agent.enabledTools);
    return [
        {
            id: "siyuan.read_current_block",
            title: "Read current block",
            description: "Read the current block kramdown and attrs.",
            scope: "read",
            readOnly: true,
            destructive: false,
            enabled: enabled.has("siyuan.read_current_block"),
        },
        {
            id: "siyuan.get_block_attrs",
            title: "Get block attrs",
            description: "Fetch block attributes by id or current block.",
            scope: "read",
            readOnly: true,
            destructive: false,
            enabled: enabled.has("siyuan.get_block_attrs"),
        },
        {
            id: "siyuan.get_block_kramdown",
            title: "Get block kramdown",
            description: "Fetch block markdown content by id or current block.",
            scope: "read",
            readOnly: true,
            destructive: false,
            enabled: enabled.has("siyuan.get_block_kramdown"),
        },
        {
            id: "siyuan.update_block",
            title: "Update block",
            description: "Replace the markdown content of a block.",
            scope: "write",
            readOnly: false,
            destructive: false,
            enabled: enabled.has("siyuan.update_block"),
        },
        {
            id: "siyuan.insert_after_current_block",
            title: "Insert after current block",
            description: "Insert markdown after the current block.",
            scope: "write",
            readOnly: false,
            destructive: false,
            enabled: enabled.has("siyuan.insert_after_current_block"),
        },
        {
            id: "siyuan.append_to_document",
            title: "Append to document",
            description: "Append markdown to the current document.",
            scope: "write",
            readOnly: false,
            destructive: false,
            enabled: enabled.has("siyuan.append_to_document"),
        },
        {
            id: "siyuan.create_doc_with_md",
            title: "Create document with Markdown",
            description: "Create a child document under the current document with Markdown content.",
            scope: "write",
            readOnly: false,
            destructive: false,
            enabled: enabled.has("siyuan.create_doc_with_md"),
        },
        {
            id: "siyuan.set_block_attrs",
            title: "Set block attrs",
            description: "Set attributes on a block.",
            scope: "write",
            readOnly: false,
            destructive: false,
            enabled: enabled.has("siyuan.set_block_attrs"),
        },
    ];
}

export function getNativeToolSpecs(settings: TianGongSettings): any[] {
    return getNativeToolDefinitions(settings)
        .filter((tool) => tool.enabled)
        .map((tool) => {
            switch (tool.id) {
                case "siyuan.read_current_block":
                    return {
                        type: "function",
                        function: {
                            name: toToolFunctionName(tool.id),
                            description: tool.description,
                            parameters: {
                                type: "object",
                                properties: {},
                            },
                        },
                    };
                default:
                    if (tool.id === "siyuan.create_doc_with_md") {
                        return {
                            type: "function",
                            function: {
                                name: toToolFunctionName(tool.id),
                                description: tool.description,
                                parameters: {
                                    type: "object",
                                    properties: {
                                        parentBlockId: {type: "string", description: "Parent block or document id"},
                                        title: {type: "string", description: "Document title"},
                                        markdown: {type: "string", description: "Markdown content for the new document"},
                                        mode: {
                                            type: "string",
                                            enum: ["child", "sibling", "root"],
                                            description: "How to place the new document relative to the parent",
                                        },
                                    },
                                    required: ["markdown"],
                                },
                            },
                        };
                    }
                    return {
                        type: "function",
                        function: {
                            name: toToolFunctionName(tool.id),
                            description: tool.description,
                            parameters: {
                                type: "object",
                                properties: {
                                    blockId: {type: "string"},
                                    data: {type: "string"},
                                    attrs: {type: "object"},
                                },
                            },
                        },
                    };
            }
        });
}

export async function getAgentToolSpecs(settings: TianGongSettings): Promise<any[]> {
    const native = getNativeToolSpecs(settings);
    const mcpTools = await listAllMcpTools(settings);
    const mcp = mcpTools.map((tool) => ({
        type: "function",
        function: {
            name: tool.id,
            description: `[MCP:${tool.serverName}] ${tool.description}`,
            parameters: normalizeInputSchema(tool.inputSchema),
        },
    }));
    return [...native, ...mcp];
}

export function toToolFunctionName(toolId: string): string {
    return toolId.replaceAll(".", "__");
}

export function fromToolFunctionName(name: string): string {
    return name.replaceAll("__", ".");
}

export async function executeNativeTool(
    toolName: string,
    args: Record<string, any>,
    context: ToolExecutionContext,
): Promise<ToolCallResult> {
    const blockId = String(args.blockId || context.currentBlockId() || "");
    switch (toolName) {
        case "siyuan.read_current_block": {
            const current = context.currentBlockId();
            const id = String(args.blockId || current);
            const [attrs, kramdown] = await Promise.all([getBlockAttrs(id), getBlockKramdown(id)]);
            return {content: JSON.stringify({blockId: id, attrs, kramdown}, null, 2)};
        }
        case "siyuan.get_block_attrs": {
            const attrs = await getBlockAttrs(blockId);
            return {content: JSON.stringify({blockId, attrs}, null, 2)};
        }
        case "siyuan.get_block_kramdown": {
            const kramdown = await getBlockKramdown(blockId);
            return {content: JSON.stringify({blockId, kramdown}, null, 2)};
        }
        case "siyuan.update_block": {
            const data = String(args.data || "");
            await updateBlock(blockId, data);
            return {content: JSON.stringify({ok: true, blockId}, null, 2)};
        }
        case "siyuan.insert_after_current_block": {
            const data = String(args.data || "");
            const id = await insertBlock(data, blockId, "");
            return {content: JSON.stringify({ok: true, blockId: id, previousID: blockId}, null, 2)};
        }
        case "siyuan.append_to_document": {
            const data = String(args.data || "");
            const id = await appendBlock(data, context.currentDocId());
            return {content: JSON.stringify({ok: true, blockId: id}, null, 2)};
        }
        case "siyuan.create_doc_with_md": {
            const markdown = String(args.markdown || "");
            if (!markdown.trim()) {
                return {content: JSON.stringify({ok: false, error: "markdown is empty"}, null, 2)};
            }
            const referenceId = String(args.parentBlockId || context.currentDocId() || context.currentBlockId() || "");
            if (!referenceId) {
                return {content: JSON.stringify({ok: false, error: "parent block is missing"}, null, 2)};
            }
            const mode = String(args.mode || "child");
            const title = sanitizeDocTitle(String(args.title || deriveTitleFromMarkdown(markdown) || "TianGong AI Document"));
            const [pathInfo, hPath] = await Promise.all([getPathByID(referenceId), getHPathByID(referenceId)]);
            const parentPath = mode === "root"
                ? "/"
                : mode === "sibling"
                    ? hPath.split("/").slice(0, -1).join("/") || "/"
                    : hPath || "/";
            const basePath = joinDocPath(parentPath, title);
            const uniquePath = await ensureUniqueDocPath(pathInfo.notebook, basePath);
            const docId = await createDocWithMd(pathInfo.notebook, uniquePath, markdown);
            return {
                content: JSON.stringify({
                    ok: true,
                    blockId: docId,
                    notebook: pathInfo.notebook,
                    path: uniquePath,
                    parentBlockId: referenceId,
                }, null, 2),
            };
        }
        case "siyuan.set_block_attrs": {
            const attrs = typeof args.attrs === "object" && args.attrs ? args.attrs : {};
            await setBlockAttrs(blockId, Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)])));
            return {content: JSON.stringify({ok: true, blockId}, null, 2)};
        }
        default:
            return {content: `Unsupported tool: ${toolName}`};
    }
}

export async function executeAgentTool(
    settings: TianGongSettings,
    functionName: string,
    args: Record<string, any>,
    context: ToolExecutionContext,
): Promise<ToolCallResult> {
    if (parseMcpToolFunctionName(functionName)) {
        return {content: await callMcpTool(settings, functionName, args)};
    }
    const toolName = fromToolFunctionName(functionName);
    return executeNativeTool(toolName, args, context);
}

export function filterEnabledTools(toolIds: string[]): string[] {
    return toolIds.filter(Boolean).filter((tool) => ALL_NATIVE_TOOL_IDS.includes(tool as typeof ALL_NATIVE_TOOL_IDS[number]));
}

function normalizeInputSchema(schema: Record<string, any>): Record<string, any> {
    if (!schema || schema.type !== "object") {
        return {type: "object", properties: {}};
    }
    return schema;
}

async function ensureUniqueDocPath(notebook: string, path: string): Promise<string> {
    const existing = await getIDsByHPath(path, notebook);
    if (existing.length === 0) {
        return path;
    }
    const suffix = `-${Date.now().toString(36).slice(-6)}`;
    return `${path}${suffix}`;
}

function joinDocPath(parentPath: string, title: string): string {
    const normalizedParent = parentPath && parentPath !== "/" ? parentPath.replace(/\/+$/g, "") : "";
    const segment = title || "Untitled";
    return `${normalizedParent || ""}/${segment}`.replace(/\/+/g, "/").replace(/^$/, "/");
}

function sanitizeDocTitle(title: string): string {
    return title
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 64) || "Untitled";
}

function deriveTitleFromMarkdown(markdown: string): string {
    const firstLine = markdown.split(/\r?\n/).find((line) => line.trim().length > 0) || "";
    return firstLine
        .replace(/^#{1,6}\s*/, "")
        .replace(/^[-*+]\s+/, "")
        .trim()
        .slice(0, 48);
}
