# 天工智绘

天工智绘是面向 SiYuan 的 OpenAI 兼容插件，提供文档感知对话、模型连接测试、文档分析，以及 Mermaid、TikZ、Excalidraw、HTML 矢量块和图片生成能力。

## 功能

- 模型测试：在设置页直接测试 `Base URL`、`API Key` 和模型配置是否可用。
- 对话工作台：支持提示词预设、当前文档上下文、模型切换、历史对话，以及将 AI 回复插入到文档。
- 文档分析：支持对当前块或图片块进行结构化分析，并回写到块属性。
- 内容生成：支持 Mermaid、TikZ、Excalidraw、HTML `<div>` 矢量块和图片生成。
- 笔记操作：对话工具可读取当前块、更新块、在当前块后插入、追加到文档，并创建子文档。
- 恢复能力：生成和更新前保存快照，必要时可以回滚到先前内容。

## 使用方式

1. 打开插件设置，配置 `Base URL`、`API Key` 和模型。

![设置](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112927789.png)

2. 点击“测试模型”，确认接口连通性与模型可用性。

![模型测试](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112845685.png)

3. 在对话区选择提示词，决定是否包含当前文档，然后发送消息。AI 回复下方的“插入”“追加文档”“子文档”按钮可以把回复写回思源。

![对话工作台](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112906633.png)

4. 在块菜单中生成 Mermaid、TikZ、Excalidraw、HTML 或图片，结果会插入到当前块后方。HTML 生成会优先输出单个 `<div>`，可用于展示内联 SVG 矢量图。

![块菜单](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112726021.png)

![生成结果](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112954113.png)

5. 需要分析时，直接对当前文档执行 AI 分析。

![分析入口](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112803898.png)

![分析结果](https://raw.githubusercontent.com/TangQi001/siyuan-plugin-tiangong/main/assets/readme/image-20260521112813322.png)

## 开发

```bash
pnpm i
pnpm run dev
```

## 构建

```bash
pnpm run build
```

赞助：GPT Image 2 试用可访问 https://nai.artai.cfd。
