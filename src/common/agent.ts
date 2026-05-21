import type {ChatMessage, SkillPreset, TianGongSettings} from "./types";
import {callChatCompletion} from "./llm";
import {executeAgentTool, getAgentToolSpecs, fromToolFunctionName, type ToolExecutionContext} from "./tools";

export interface AgentRunResult {
    messages: ChatMessage[];
    finalText: string;
}

export function getSkill(settings: TianGongSettings, skillId: string): SkillPreset {
    return settings.agent.skills.find((item) => item.id === skillId) || settings.agent.skills[0];
}

export function buildConversationMessages(
    settings: TianGongSettings,
    skill: SkillPreset,
    history: ChatMessage[],
    userMessage: string,
    promptInstruction = "",
): ChatMessage[] {
    const systemParts = [
        settings.agent.systemPrompt,
        skill.systemPrompt,
        promptInstruction ? `User selected prompt:\n${promptInstruction}` : "",
        "You may use tools when useful.",
        "When you need a tool, call it directly instead of guessing.",
        "When the user asks to insert, append, update, or create SiYuan content, prefer the available SiYuan tools instead of only describing the operation.",
        "When creating a subdocument, use the document creation tool with a concise title and Markdown body.",
        "When the user asks for HTML/vector graphics, produce a single <div>-wrapped HTML block; inline SVG is preferred for vector drawings.",
        "Return concise answers.",
    ].filter(Boolean);
    return [
        {role: "system", content: systemParts.join("\n\n")},
        ...history,
        {role: "user", content: userMessage},
    ];
}

export async function runAgentTurn(
    settings: TianGongSettings,
    skillId: string,
    history: ChatMessage[],
    userMessage: string,
    context: ToolExecutionContext,
    promptInstruction = "",
): Promise<AgentRunResult> {
    const skill = getSkill(settings, skillId);
    const messages: ChatMessage[] = buildConversationMessages(settings, skill, history, userMessage, promptInstruction);
    const toolSpecs = (await getAgentToolSpecs(settings)).filter((tool) => {
        const name = String(tool.function?.name || "");
        if (name.startsWith("mcp__")) {
            return skill.enabledTools.includes("mcp") || skill.enabledTools.includes(name);
        }
        return skill.enabledTools.includes(fromToolFunctionName(name));
    });
    const model = skill.modelOverride.trim() || settings.agent.model.trim() || settings.llm.model;
    let turns = 0;

    while (turns < settings.agent.maxTurns) {
        const response = await callChatCompletion(settings, {
            model,
            messages,
            tools: toolSpecs,
        });
        const choice = response?.choices?.[0]?.message;
        const toolCalls = Array.isArray(choice?.tool_calls) ? choice.tool_calls : [];
        if (toolCalls.length === 0) {
            const text = String(choice?.content || "");
            messages.push({role: "assistant", content: text});
            return {messages, finalText: text};
        }

        const assistantMessage: ChatMessage = {
            role: "assistant",
            content: choice?.content || "",
            toolCalls,
        };
        messages.push(assistantMessage);
        for (const toolCall of toolCalls) {
            const toolName = String(toolCall.function?.name || "");
            const argsText = String(toolCall.function?.arguments || "{}");
            let args: Record<string, any> = {};
            try {
                args = JSON.parse(argsText) as Record<string, any>;
            } catch {
                args = {};
            }
            const result = await executeAgentTool(settings, toolName, args, context);
            messages.push({
                role: "tool",
                content: result.content,
                toolName,
                toolCallId: String(toolCall.id || ""),
            });
        }
        turns += 1;
    }

    const fallback = "The agent reached the tool loop limit.";
    messages.push({role: "assistant", content: fallback});
    return {messages, finalText: fallback};
}
