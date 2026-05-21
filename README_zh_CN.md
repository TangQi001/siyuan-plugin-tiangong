# 天工智绘

面向 SiYuan 的 OpenAI-compatible 插件，提供文档感知对话、模型测试、文档分析，以及 HTML、图表和图片生成。

## 功能

- 模型测试：在设置页直接测试 `Base URL`、`API Key` 和模型配置是否可用。
- 对话工作台：支持提示词预设、当前文档上下文、模型切换、历史对话和消息回收。
- 文档分析：支持对当前块或图片块进行结构化分析，并回写到备注字段。
- 内容生成：支持 Mermaid、TikZ、Excalidraw、HTML 和图片生成。
- 绑定与恢复：支持参考块绑定、生成结果刷新、块状态快照与回退。
- 工具扩展：支持 SiYuan 原生工具与 MCP 服务器工具按需启用。

## 使用方式

1. 打开插件设置，配置 `Base URL`、`API Key` 和模型。

![设置](https://raw.githubusercontent.com/TangQi001/siyuan-plguin-tiangong/main/assets/readme/image-20260521112927789.png)

2. 点击“测试模型”，确认接口连通性与模型可用性。

![模型测试](https://raw.githubusercontent.com/TangQi001/siyuan-plguin-tiangong/main/assets/readme/image-20260521112845685.png)

3. 在对话区选择提示词，决定是否包含当前文档，再发送消息。

![对话工作台](https://raw.githubusercontent.com/TangQi001/siyuan-plguin-tiangong/main/assets/readme/image-20260521112906633.png)

4. 在块菜单中生成图表、HTML 或图片，结果会插入到当前块后方。

![块菜单](https://raw.githubusercontent.com/TangQi001/siyuan-plguin-tiangong/main/assets/readme/image-20260521112726021.png)

![生成结果](https://raw.githubusercontent.com/TangQi001/siyuan-plguin-tiangong/main/assets/readme/image-20260521112954113.png)

5. 需要分析时，直接对当前文档执行 AI 分析。

![分析入口](https://raw.githubusercontent.com/TangQi001/siyuan-plguin-tiangong/main/assets/readme/image-20260521112803898.png)

![分析结果](https://raw.githubusercontent.com/TangQi001/siyuan-plguin-tiangong/main/assets/readme/image-20260521112813322.png)

## 开发

```bash
pnpm i
pnpm run dev
```

## 构建

```bash
pnpm run build
```

赞助：申请免费 GPT Image 2 试用可以在这个网站：https://nai.artai.cfd。
