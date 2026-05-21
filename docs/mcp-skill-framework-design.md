# TianGong AI MCP and Skill Framework Design

## Goal

Build a lightweight chat entry for SiYuan that can:

1. talk to models,
2. switch models per conversation or per task,
3. expose SiYuan actions as explicit tools,
4. load local skill presets as prompt/workflow bundles,
5. connect to MCP servers through a controlled adapter layer.

The plugin should not hide tool usage behind vague automation. Every tool must be visible, selectable, and auditable.

## Architecture

### 1. UI Layer

- Sakura-style chat sidebar.
- Conversation list, model selector, tool toggles, and input box.
- No explanatory dashboard.
- No heavy visual controls beyond the minimum needed to steer the agent.

### 2. Agent Orchestration Layer

- Maintains one conversation state per thread.
- Builds the final prompt from:
  - system prompt,
  - selected skill preset,
  - enabled tools,
  - current SiYuan context,
  - user message.
- Chooses the active model for the conversation.

### 3. Tool Registry Layer

Two tool classes:

- Native SiYuan tools:
  - read block
  - get block attrs
  - set block attrs
  - insert block
  - append block
  - update block
  - query SQL
  - open document
  - search blocks

- MCP tools:
  - discovered from configured MCP servers
  - filtered by allowlist
  - enabled per conversation or per skill

Each tool should declare:

- id
- title
- description
- readOnly / destructive flag
- required scope
- input schema

### 4. Skill Layer

Skills are local workflow bundles, not hidden magic.

Each skill should include:

- name
- description
- system prompt template
- default model override
- enabled tools
- optional step policy

Initial skills:

- summarize
- extract tasks
- rewrite note
- generate Mermaid
- generate TikZ
- organize knowledge

### 5. MCP Bridge Layer

The plugin should not treat MCP as a UI feature. It is a capability bridge.

Recommended boundary:

- kernel side manages MCP connections,
- UI side only configures servers and selects tools,
- conversation layer receives tool results as structured data.

Supported transports:

- stdio for local servers,
- streamable HTTP for remote/local HTTP servers.

## Security Rules

1. Tool access is opt-in.
2. Destructive tools are disabled by default.
3. MCP servers are per-user configuration, never implicit.
4. Tool calls are logged in conversation history.
5. Skills can only use tools explicitly allowed to them.
6. Prompt content should not silently include hidden tools or hidden instructions.

## Implementation Order

1. Chat sidebar and conversation state.
2. Native SiYuan tool registry.
3. Skill preset loading.
4. Model selection per conversation.
5. MCP adapter and server registry.
6. Tool call audit log and permissions UI.

## Notes

This design keeps the upper bound high while keeping the first implementation small and reviewable.
