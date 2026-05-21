import type {BlockAttrsResponse, ApiResponse, KramdownResponse} from "./types";

export async function postJson<T>(path: string, data: any): Promise<T> {
    const response = await fetch(path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(text || response.statusText);
    }
    return text ? JSON.parse(text) as T : ({} as T);
}

export async function getBlockAttrs(id: string): Promise<Record<string, string>> {
    const response = await postJson<BlockAttrsResponse>("/api/attr/getBlockAttrs", {id});
    return response.data || {};
}

export async function getHPathByID(id: string): Promise<string> {
    const response = await postJson<ApiResponse<string>>("/api/filetree/getHPathByID", {id});
    return response.data || "";
}

export async function getPathByID(id: string): Promise<{notebook: string; path: string}> {
    const response = await postJson<ApiResponse<{notebook: string; path: string}>>("/api/filetree/getPathByID", {id});
    return response.data || {notebook: "", path: ""};
}

export async function getIDsByHPath(path: string, notebook: string): Promise<string[]> {
    const response = await postJson<ApiResponse<string[]>>("/api/filetree/getIDsByHPath", {path, notebook});
    return response.data || [];
}

export async function createDocWithMd(notebook: string, path: string, markdown: string): Promise<string> {
    const response = await postJson<ApiResponse<string>>("/api/filetree/createDocWithMd", {
        notebook,
        path,
        markdown,
    });
    return response.data || "";
}

export async function setBlockAttrs(id: string, attrs: Record<string, string>): Promise<void> {
    await postJson<ApiResponse<null>>("/api/attr/setBlockAttrs", {id, attrs});
}

export async function uploadAsset(fileName: string, blob: Blob): Promise<string> {
    const formData = new FormData();
    formData.append("assetsDirPath", "/assets/");
    formData.append("file[]", blob, fileName);
    const response = await fetch("/api/asset/upload", {
        method: "POST",
        body: formData,
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(text || response.statusText);
    }
    const data = text ? JSON.parse(text) as ApiResponse<{succMap?: Record<string, string>}> : null;
    const savedPath = data?.data?.succMap?.[fileName];
    if (!savedPath) {
        throw new Error("asset upload failed");
    }
    return savedPath;
}

export async function getBlockKramdown(id: string): Promise<string> {
    const response = await postJson<KramdownResponse>("/api/block/getBlockKramdown", {id});
    return response.data?.kramdown || "";
}

export async function insertBlock(data: string, previousID: string, parentID = ""): Promise<string> {
    const response = await postJson<ApiResponse<any[]>>("/api/block/insertBlock", {
        dataType: "markdown",
        data,
        previousID,
        parentID,
    });
    return response.data?.[0]?.doOperations?.[0]?.id || "";
}

export async function appendBlock(data: string, parentID: string): Promise<string> {
    const response = await postJson<ApiResponse<any[]>>("/api/block/appendBlock", {
        dataType: "markdown",
        data,
        parentID,
    });
    return response.data?.[0]?.doOperations?.[0]?.id || "";
}

export async function updateBlock(id: string, data: string): Promise<void> {
    await postJson<ApiResponse<any[]>>("/api/block/updateBlock", {
        id,
        dataType: "markdown",
        data,
    });
}

export async function fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.text();
}

export async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function normalizeAssetUrl(src: string): string {
    if (src.startsWith("http://") || src.startsWith("https://")) {
        return src;
    }
    const normalized = src.startsWith("/") ? src : `/${src}`;
    return new URL(normalized, window.location.origin).toString();
}

export function extractImageSources(kramdown: string): string[] {
    const matches = kramdown.matchAll(/!\[[^\]]*]\(([^)]+)\)/g);
    const result: string[] = [];
    for (const match of matches) {
        if (match[1]) {
            result.push(match[1].trim());
        }
    }
    return result;
}

export async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function safeJsonParse<T>(value: string, fallback: T): T {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}
