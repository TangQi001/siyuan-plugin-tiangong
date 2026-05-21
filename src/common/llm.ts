import type {ArtifactFormat, ChatMessage, TianGongSettings} from "./types";
import {arrayBufferToBase64} from "./api";

export interface LLMProbeResult {
    ok: boolean;
    message: string;
}

export interface LLMAnalysisResult {
    summary: string;
    tags: string[];
    kind: string;
    raw: string;
}

export interface ArtifactResult {
    format: ArtifactFormat;
    content: string;
    summary: string;
    raw: string;
}

export interface ImageGenerationResult {
    blob: Blob;
    prompt: string;
    raw: any;
}

interface ChatInput {
    prompt: string;
    model?: string;
    imageDataUrls?: string[];
}

export interface ChatCompletionRequest {
    messages: ChatMessage[];
    model?: string;
    tools?: any[];
}

export async function probeLLM(settings: TianGongSettings): Promise<LLMProbeResult> {
    try {
        const response = await fetch(buildUrl(settings.llm.baseUrl, "/models"), {
            headers: buildHeaders(settings),
        });
        if (!response.ok) {
            return {ok: false, message: await readResponseError(response)};
        }
        return {ok: true, message: "openai-compatible service ready"};
    } catch (error) {
        return {ok: false, message: error instanceof Error ? error.message : String(error)};
    }
}

export async function probeChatModel(settings: TianGongSettings): Promise<LLMProbeResult> {
    try {
        const response = await fetch(buildUrl(settings.llm.baseUrl, "/chat/completions"), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...buildHeaders(settings),
            },
        body: JSON.stringify({
            model: settings.llm.model,
            messages: [
                {role: "user", content: "ping"},
            ],
                temperature: 0,
                max_tokens: 1,
        }),
        });
        if (!response.ok) {
            return {ok: false, message: await readResponseError(response)};
        }
        const data = await response.json();
        const answer = data?.choices?.[0]?.message?.content;
        const suffix = typeof answer === "string" && answer.trim().length > 0 ? `: ${answer.trim().slice(0, 40)}` : "";
        return {ok: true, message: `model ok${suffix}`};
    } catch (error) {
        return {ok: false, message: error instanceof Error ? error.message : String(error)};
    }
}

export async function analyzeTextBlock(settings: TianGongSettings, content: string): Promise<LLMAnalysisResult> {
    const raw = await callChat(settings, {
        prompt: [
            "You are a strict knowledge-structuring assistant.",
            "Return compact JSON only: {\"summary\":\"...\",\"tags\":[\"...\"],\"kind\":\"...\"}.",
            "Prefer concise academic labels.",
            "",
            content,
        ].join("\n"),
    });
    return normalizeAnalysis(raw);
}

export async function analyzeImageBlock(settings: TianGongSettings, imageUrl: string, context: string): Promise<LLMAnalysisResult> {
    const raw = await callChat(settings, {
        prompt: [
            "You are a strict multimodal annotator.",
            "Return compact JSON only: {\"summary\":\"...\",\"tags\":[\"...\"],\"kind\":\"...\"}.",
            "Summarize the image and extract visual structure tags.",
            "",
            context,
        ].join("\n"),
        imageDataUrls: [await toDataUrl(imageUrl)],
    });
    return normalizeAnalysis(raw);
}

export async function generateArtifact(
    settings: TianGongSettings,
    format: ArtifactFormat,
    sourceText: string,
    targetText: string,
    imageUrls: string[] = [],
): Promise<ArtifactResult> {
    const imageDataUrls = await Promise.all(imageUrls.slice(0, 1).map((url) => toDataUrl(url)));
    const raw = await callChat(settings, {
        model: settings.artifact.model.trim() || settings.llm.model,
        prompt: buildArtifactPrompt(settings.artifact.prompts[format], format, sourceText, targetText),
        imageDataUrls,
    });
    const content = normalizeArtifactContent(format, raw);
    if (!content.trim()) {
        throw new Error("empty artifact response");
    }
    return {
        format,
        content,
        summary: summarizeArtifact(format, content),
        raw,
    };
}

export async function generateImage(settings: TianGongSettings, sourceText: string): Promise<ImageGenerationResult> {
    const prompt = buildImagePrompt(settings.artifact.imagePrompt, sourceText);
    const response = await fetch(buildUrl(settings.llm.baseUrl, "/images/generations"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...buildHeaders(settings),
        },
        body: JSON.stringify({
            model: settings.artifact.imageModel.trim() || "gpt-image-1",
            prompt,
            n: 1,
            size: "1024x1024",
        }),
    });
    if (!response.ok) {
        throw new Error(await readResponseError(response));
    }
    const data = await response.json();
    const first = data?.data?.[0];
    if (first?.b64_json) {
        return {
            blob: base64ToBlob(first.b64_json, "image/png"),
            prompt,
            raw: data,
        };
    }
    if (first?.url) {
        const imageResponse = await fetch(first.url);
        if (!imageResponse.ok) {
            throw new Error(`${imageResponse.status} ${imageResponse.statusText}`);
        }
        return {
            blob: await imageResponse.blob(),
            prompt,
            raw: data,
        };
    }
    throw new Error("image generation response is empty");
}

function buildArtifactPrompt(template: string, format: ArtifactFormat, sourceText: string, targetText: string): string {
    const sourceSnippet = limitPromptText(sourceText, 6000);
    const targetSnippet = limitPromptText(targetText, 3000);
    return (template || "")
        .replaceAll("{format}", format)
        .replaceAll("{sourceText}", sourceSnippet || "(empty)")
        .replaceAll("{targetText}", targetSnippet || "(empty)");
}

function buildImagePrompt(template: string, sourceText: string): string {
    return (template || "{sourceText}")
        .replaceAll("{sourceText}", limitPromptText(sourceText, 4000) || "(empty)");
}

function limitPromptText(text: string, limit: number): string {
    const value = (text || "").trim();
    if (value.length <= limit) {
        return value;
    }
    return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

export async function callChatCompletion(settings: TianGongSettings, request: ChatCompletionRequest): Promise<any> {
    const messages = request.messages.map((message) => {
        if (message.role === "tool") {
            return {
                role: "tool",
                content: message.content,
                tool_call_id: message.toolCallId,
                name: message.toolName,
            };
        }
        if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
            return {
                role: "assistant",
                content: message.content,
                tool_calls: message.toolCalls,
            };
        }
        return {
            role: message.role,
            content: message.content,
        };
    });
    const response = await fetch(buildUrl(settings.llm.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...buildHeaders(settings),
        },
        body: JSON.stringify({
            model: request.model || settings.llm.model,
            messages,
            tools: request.tools,
            tool_choice: request.tools && request.tools.length > 0 ? "auto" : undefined,
            temperature: 0,
        }),
    });
    if (!response.ok) {
        throw new Error(await readResponseError(response));
    }
    return response.json();
}

async function callChat(settings: TianGongSettings, input: ChatInput): Promise<string> {
    const content = input.imageDataUrls && input.imageDataUrls.length > 0
        ? [
            {type: "text", text: input.prompt},
            ...input.imageDataUrls.map((image) => ({
                type: "image_url",
                image_url: {url: image},
            })),
        ]
        : input.prompt;
    const response = await fetch(buildUrl(settings.llm.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...buildHeaders(settings),
        },
        body: JSON.stringify({
            model: input.model || settings.llm.model,
            messages: [
                {role: "user", content},
            ],
            temperature: 0,
        }),
    });
    if (!response.ok) {
        throw new Error(await readResponseError(response));
    }
    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "";
}

function buildUrl(baseUrl: string, path: string): string {
    const trimmedBase = baseUrl.replace(/\/$/, "");
    const normalized = trimmedBase.endsWith("/v1") ? trimmedBase : `${trimmedBase}/v1`;
    const trimmedPath = path.replace(/^\//, "");
    return `${normalized}/${trimmedPath}`;
}

function buildHeaders(settings: TianGongSettings): Record<string, string> {
    return settings.llm.apiKey ? {Authorization: `Bearer ${settings.llm.apiKey}`} : {};
}

export function normalizeAnalysis(raw: string): LLMAnalysisResult {
    const json = extractJsonObject(raw);
    if (json) {
        const tags = Array.isArray(json.tags) ? json.tags.map(String) : [];
        return {
            summary: String(json.summary || raw).trim(),
            tags,
            kind: String(json.kind || "analysis").trim(),
            raw,
        };
    }
    return {
        summary: raw.trim(),
        tags: [],
        kind: "analysis",
        raw,
    };
}

function normalizeArtifactContent(format: ArtifactFormat, raw: string): string {
    const stripped = stripCodeFence(raw).trim();
    if (format === "mermaid") {
        return stripped.replace(/^mermaid\s*/i, "").trim();
    }
    if (format === "excalidraw") {
        const parsed = extractJsonObject(stripped);
        if (parsed) {
            return JSON.stringify(parsed, null, 2);
        }
        return JSON.stringify(buildFallbackExcalidrawScene(stripped), null, 2);
    }
    if (format === "html") {
        return normalizeHtmlArtifact(stripped);
    }
    return stripped;
}

function stripCodeFence(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
    return match ? match[1] : trimmed;
}

function summarizeArtifact(format: ArtifactFormat, content: string): string {
    const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0) || "";
    return `${format}: ${firstLine.slice(0, 80)}`.trim();
}

function extractJsonObject(text: string): any | null {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first < 0 || last <= first) {
        return null;
    }
    try {
        return JSON.parse(text.slice(first, last + 1));
    } catch {
        return null;
    }
}

function buildFallbackExcalidrawScene(label: string) {
    const now = Date.now();
    return {
        type: "excalidraw",
        version: 2,
        source: "tiangong-ai",
        elements: [
            {
                id: `text-${now}`,
                type: "text",
                x: 80,
                y: 80,
                width: Math.max(160, label.length * 8),
                height: 32,
                angle: 0,
                strokeColor: "#1e1e1e",
                backgroundColor: "transparent",
                fillStyle: "solid",
                strokeWidth: 1,
                strokeStyle: "solid",
                roughness: 0,
                opacity: 100,
                groupIds: [],
                frameId: null,
                index: "a0",
                roundness: null,
                seed: now,
                version: 1,
                versionNonce: now,
                isDeleted: false,
                boundElements: null,
                updated: now,
                link: null,
                locked: false,
                text: label || "TianGong AI scene",
                fontSize: 20,
                fontFamily: 1,
                textAlign: "left",
                verticalAlign: "top",
                baseline: 18,
                containerId: null,
                originalText: label || "TianGong AI scene",
                lineHeight: 1.25,
            },
        ],
        appState: {
            gridSize: null,
            viewBackgroundColor: "#ffffff",
        },
        files: {},
    };
}

function normalizeHtmlArtifact(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
        return "";
    }
    if (/^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
        const body = extractHtmlBody(trimmed);
        if (body.trim()) {
            return body.trim();
        }
    }
    if (/^<div[\s>]/i.test(trimmed)) {
        return trimmed;
    }
    return `<div class="tgai-html-artifact">\n${trimmed}\n</div>`;
}

function extractHtmlBody(html: string): string {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch?.[1]) {
        return bodyMatch[1];
    }
    const htmlMatch = html.match(/<html[^>]*>([\s\S]*?)<\/html>/i);
    if (htmlMatch?.[1]) {
        return htmlMatch[1]
            .replace(/<head[\s\S]*?<\/head>/i, "")
            .trim();
    }
    return html;
}

async function toDataUrl(imageUrl: string): Promise<string> {
    const response = await fetch(imageUrl);
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    const mimeType = response.headers.get("content-type") || "image/png";
    const base64 = await arrayBufferToBase64(await response.arrayBuffer());
    return `data:${mimeType};base64,${base64}`;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], {type: mimeType});
}

async function readResponseError(response: Response): Promise<string> {
    const body = await response.text().catch(() => "");
    const detail = body.trim();
    if (detail) {
        return detail;
    }
    return `${response.status} ${response.statusText}`;
}
