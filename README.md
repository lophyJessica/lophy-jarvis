# Jarvis AI Console

基于 React 19、TypeScript、Vite、Ant Design 和 Canvas 2D 的全景 AI 助手控制台。

## 本地运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

开发服务器默认运行于 `http://127.0.0.1:5188`。Hermes 尚未配置时，粒子动画、文本界面和浏览器语音能力仍可独立验收。

## Hermes 配置

在 `.env.local` 中填写：

```dotenv
VITE_HERMES_API_URL=https://YOUR_VPS_IP:8642
VITE_HERMES_API_KEY=YOUR_HERMES_API_KEY
```

Hermes API Server 需要允许来自本地开发地址的 CORS 请求，并提供 OpenAI 兼容的 `/v1/models` 与 `/v1/chat/completions` 接口。修改环境变量后需要重启开发服务器。

## 可用命令

- `npm run dev`：启动开发服务器
- `npm run build`：类型检查并构建生产包
- `npm run lint`：运行代码规范检查
- `npm run preview`：预览生产构建
