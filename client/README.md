# wechat-chat-client（前端）

## 三种起法，先想清楚「谁要访问」

| 场景 | 命令 | 地址 | 是否暴露源码 |
| --- | --- | --- | --- |
| 只在自己这台机器上开发（要热更新） | `npm run dev` | http://127.0.0.1:5173 | 否（只有自己能连） |
| **局域网共享（手机 / 别的电脑用）** | 见下方「单端口」 | http://<本机IP>:3001 | **否** —— 只发构建产物 |
| 局域网 + 一定要热更新 | `npm run dev:lan` | http://<本机IP>:5173 | **是** —— 会给出全部原始源码 |

## 局域网共享：走后端单端口（推荐）

前端**不再需要单独起服务**。构建一次，由后端在同一个端口把 `dist/` 发出去：

```bash
cd client && npm run build      # 产出 client/dist
cd ../server && npm run start:lan   # = node index.js --host 0.0.0.0
# 手机浏览器打开 http://<本机IP>:3001
```

好处：

- **只有一个源**：页面、`/api`、`/uploads`、`/socket.io` 全在 3001 → 无代理、无 CORS、socket.io 同源直连
- 发出去的是**构建产物**，不含 `/src`、不含 source map
- 后端**看到真实客户端 IP**（没有代理这一跳），API 密钥的 IP 绑定与登录限流因此按设备生效
- 改完代码只要重新 `npm run build`，**不用重启后端**（静态文件按请求读盘），手机刷新即见

更顺手的写法：`npx vite build --watch` 加上后端，保存即自动重建，手机下拉刷新即可（不是 HMR）。

配置在 `server/config.yaml` → `client.serve` / `client.dist`（默认 `true` / `../client/dist`）；
`SERVE_CLIENT=0` 或 `client.serve: false` 可关掉，退回「只提供 API」。

## 为什么局域网共享不用 dev server

dev 模式下 Vite 直接托管整个工程目录：浏览器拿到的 `/src/*.jsx` **就是源文件本身**，
每个模块还内联了 base64 source map（`sourcesContent` 是未压缩原文），
`/package.json`、`/vite.config.js`、`/package-lock.json` 也能直接下载。
这是外部渗透报告的 **F-01（高）** —— 只要用 dev 模式对外服务，源码就必然外泄，
**没有开关能关掉**（不是配置问题，是 dev 模式的工作方式，浏览器要执行的就是源文件）。

`dev:lan` 只在自己的可信网络里、且确实需要 HMR 时用。

## 构建 / 检查

```bash
npm run build     # → dist/（无 source map，显式写死在 vite.config.js）
npm run lint      # 0 error / 16 warning（既有基线）
```

改完 `vite.config.js` 或 JSON 配置后，建议在 `server` 目录跑一次
`npm run test:static`（20 项）：它用隔离实例验证「前端托管 + 接口不被前端吃掉」。

## 其他

- dev server 的后端地址可用 `BACKEND_URL` 覆盖（默认 http://localhost:3001）。
- dev server 监听地址用 `VITE_DEV_HOST`（默认 `127.0.0.1`）。

---

下面是 Vite 官方模板的原始说明，保留备查。

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
