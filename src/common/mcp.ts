import type {McpServerConfig, TianGongSettings} from "./types";

export interface McpToolSpec {
    id: string;
    title: string;
    description: string;
    serverId: string;
    serverName: string;
    toolName: string;
    enabled: boolean;
    readOnly: boolean;
    destructive: boolean;
    inputSchema: Record<string, any>;
}

interface McpSession {
    sessionId: string;
    requestId: number;
    protocolVersion: string;
}

const sessions = new Map<string, Promise<McpSession>>();
const MCP_PROTOCOL_VERSION = "2025-11-25";

export function listEnabledMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
    return servers.filter((server) => server.enabled);
}

export function toMcpToolFunctionName(serverId: string, toolName: string): string {
    return `mcp__${encodeURIComponent(serverId)}__${encodeURIComponent(toolName)}`;
}

export function parseMcpToolFunctionName(name: string): {serverId: string; toolName: string} | null {
    if (!name.startsWith("mcp__")) {
        return null;
    }
    const parts = name.slice(5).split("__");
    if (parts.length < 2) {
        return null;
    }
    return {
        serverId: decodeURIComponent(parts[0]),
        toolName: decodeURIComponent(parts.slice(1).join("__")),
    };
}

export async function listAllMcpTools(settings: TianGongSettings): Promise<McpToolSpec[]> {
    const groups = await Promise.allSettled(listEnabledMcpServers(settings.agent.mcpServers).map((server) => listMcpTools(server)));
    const result: McpToolSpec[] = [];
    for (const group of groups) {
        if (group.status === "fulfilled") {
            result.push(...group.value);
        }
    }
    return result;
}

export async function listMcpTools(server: McpServerConfig): Promise<McpToolSpec[]> {
    if (!server.enabled) {
        return [];
    }
    const session = await connectMcpServer(server);
    const response = await callJsonRpc(server, session, "tools/list", {});
    const payload = response?.result || response;
    const tools = Array.isArray(payload?.tools) ? payload.tools : [];
    const allow = new Set(server.allowTools.filter(Boolean));
    return tools
        .filter((tool: any) => allow.size === 0 || allow.has(String(tool.name || "")))
        .map((tool: any) => ({
            id: toMcpToolFunctionName(server.id, String(tool.name || "")),
            title: String(tool.title || tool.name || server.name || server.id),
            description: String(tool.description || `${server.name || server.id}: ${tool.name || ""}`),
            serverId: server.id,
            serverName: server.name || server.id,
            toolName: String(tool.name || ""),
            enabled: true,
            readOnly: Boolean(tool.annotations?.readOnlyHint),
            destructive: Boolean(tool.annotations?.destructiveHint),
            inputSchema: normalizeObject(tool.inputSchema),
        }));
}

export async function callMcpTool(
    settings: TianGongSettings,
    functionName: string,
    args: Record<string, any>,
): Promise<string> {
    const parsed = parseMcpToolFunctionName(functionName);
    if (!parsed) {
        return JSON.stringify({ok: false, error: `Invalid MCP tool name: ${functionName}`}, null, 2);
    }
    const server = settings.agent.mcpServers.find((item) => item.id === parsed.serverId && item.enabled);
    if (!server) {
        return JSON.stringify({ok: false, error: `MCP server is disabled or missing: ${parsed.serverId}`}, null, 2);
    }
    if (server.allowTools.length > 0 && !server.allowTools.includes(parsed.toolName)) {
        return JSON.stringify({ok: false, error: `MCP tool is not allowed: ${parsed.toolName}`}, null, 2);
    }
    const session = await connectMcpServer(server);
    const response = await callJsonRpc(server, session, "tools/call", {
        name: parsed.toolName,
        arguments: args,
    });
    return JSON.stringify({
        ok: true,
        serverId: parsed.serverId,
        toolName: parsed.toolName,
        response: response?.result || response,
    }, null, 2);
}

export async function closeMcpClients(): Promise<void> {
    sessions.clear();
}

async function connectMcpServer(server: McpServerConfig): Promise<McpSession> {
    if (server.transport !== "streamable-http") {
        throw new Error(`MCP transport ${server.transport} is configured but only streamable-http is enabled in this runtime.`);
    }
    if (!server.url.trim()) {
        throw new Error(`MCP server ${server.id} has no URL.`);
    }
    const cacheKey = `${server.id}:${server.url}`;
    const existing = sessions.get(cacheKey);
    if (existing) {
        return existing;
    }
    const pending = (async () => {
        const initializeResult = await callJsonRpc(server, {
            sessionId: "",
            requestId: 0,
            protocolVersion: MCP_PROTOCOL_VERSION,
        }, "initialize", {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
                name: "tiangong-ai",
                version: "0.1.0",
            },
        }, false);
        const sessionId = String(initializeResult.sessionId || initializeResult.headers?.["mcp-session-id"] || "");
        if (!sessionId) {
            throw new Error(`MCP server ${server.id} did not return a session id.`);
        }
        const session: McpSession = {
            sessionId,
            requestId: 1,
            protocolVersion: MCP_PROTOCOL_VERSION,
        };
        await callJsonRpc(server, session, "notifications/initialized", {}, true);
        return session;
    })().catch((error) => {
        sessions.delete(cacheKey);
        throw error;
    });
    sessions.set(cacheKey, pending);
    return pending;
}

async function callJsonRpc(
    server: McpServerConfig,
    session: McpSession,
    method: string,
    params: Record<string, any>,
    notification = false,
): Promise<any> {
    const url = new URL(server.url);
    const requestId = notification ? undefined : session.requestId + 1;
    if (!notification) {
        session.requestId = requestId || session.requestId;
    }
    const payload = notification
        ? {jsonrpc: "2.0", method, params}
        : {jsonrpc: "2.0", id: requestId, method, params};
    const response = await fetch(url.toString(), {
        method: "POST",
        headers: buildHeaders(session),
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        throw new Error(`MCP ${method} failed: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    if (!text.trim()) {
        return {
            headers: normalizeHeaders(response.headers),
            result: null,
        };
    }
    const parsed = parseJsonOrSse(text);
    return {
        headers: normalizeHeaders(response.headers),
        ...(parsed || {}),
    };
}

function buildHeaders(session: McpSession): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": session.protocolVersion || MCP_PROTOCOL_VERSION,
    };
    if (session.sessionId) {
        headers["Mcp-Session-Id"] = session.sessionId;
    }
    return headers;
}

function parseJsonOrSse(text: string): any {
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return JSON.parse(trimmed);
    }
    const events = trimmed.split(/\n\s*\n/);
    for (const event of events) {
        const lines = event.split(/\r?\n/);
        const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
        if (!data) {
            continue;
        }
        try {
            return JSON.parse(data);
        } catch {
            return {result: data};
        }
    }
    return {result: trimmed};
}

function normalizeHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key.toLowerCase()] = value;
    });
    return result;
}

function normalizeObject(value: unknown): Record<string, any> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, any>;
    }
    return {type: "object", properties: {}};
}
