# TianGong AI

TianGong AI is an OpenAI-compatible SiYuan plugin for document-aware chat, model testing, document analysis, and HTML, diagram, and image generation.

## Features

- Model testing: test the configured `Base URL`, `API Key`, and model directly in settings.
- Chat workspace: use prompt presets, current-document context, model switching, history, and assistant-message insertion.
- Document analysis: analyze the current block or image block and write structured results back to block attributes.
- Content generation: generate Mermaid, TikZ, Excalidraw, HTML `<div>` vector blocks, and images.
- Recovery: snapshot block states and restore previous content after generated edits.
- Tool expansion: enable SiYuan native tools and MCP server tools as needed.

## Usage

1. Open plugin settings and configure `Base URL`, `API Key`, and model.

![Settings](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112927789.png)

2. Click "Test model" to verify API connectivity and model availability.

![Model test](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112845685.png)

3. In the chat area, choose a prompt preset, decide whether to include the current document, and send a message.

![Chat workspace](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112906633.png)

4. Generate diagrams, HTML, or images from the block menu. Results are inserted after the current block.

![Block menu](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112726021.png)

![Generated content](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112954113.png)

5. When analysis is needed, run AI analysis on the current document.

![Analysis entry](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112803898.png)

![Analysis result](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112813322.png)

## Development

```bash
pnpm i
pnpm run dev
```

## Build

```bash
pnpm run build
```

Sponsor: apply for a free GPT Image 2 trial at https://nai.artai.cfd.
