import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:3001';

// ============================================================
// 前端有三种起法，别搞混（详见 client/README.md）：
//
//   1) `npm run dev`（默认，本文件里的 server 配置）
//      只绑 127.0.0.1，自己开发用；需要热更新。
//
//   2) `npm run build` + 后端单端口（**局域网共享用这个**）
//      后端托管 client/dist：npm run start:lan → http://<本机IP>:3001
//      只发构建产物，无 /src、无 source map，无代理无 CORS。
//      （后端那一侧见 server/config.yaml → client.serve）
//
//   3) `npm run dev:lan`
//      dev server 绑 0.0.0.0。**会把完整源码发给同网段任何人** —— 见下。
//
// dev server 的默认值保持回环，因为 dev 模式下 Vite 直接托管**整个工程目录**：
// 每个模块都内联 base64 source map，sourcesContent 就是未压缩的原始源码，
// 递归爬一遍模块依赖图即可还原全部源文件；/package.json、/vite.config.js
// （含后端地址与代理规则）、/package-lock.json 也都能直接下载。
// 这就是外部渗透报告的 F-01 —— 只要用 dev 模式对外服务，源码就必然外泄，
// 没有开关能关掉（浏览器拿到的就是源文件本身），所以对外一律走 2)。
// ============================================================
const DEV_HOST = process.env.VITE_DEV_HOST || '127.0.0.1';

// 代理：dev 模式下浏览器眼里全是 5173，同源，CORS 不触发。
// （局域网共享走后端单端口，那条路没有代理，也不需要代理。）
//
// [SEC] xfwd: true —— 转发时把**真实客户端 IP** 追加到 X-Forwarded-For。
//   后端默认 trust_proxy: false（只认 TCP 对端），所以直连部署下不会采信；
//   只有「后端只监听 127.0.0.1、别的机器只能经本代理访问」时才把
//   server/config.yaml 的 security.trust_proxy 设为 true，此时后端的
//   IP 绑定 / 失败次数才会落在真实客户端 IP 而不是 127.0.0.1。
const PROXY = {
  '/api': {
    target: BACKEND,
    changeOrigin: true,
    xfwd: true
  },
  '/uploads': {
    target: BACKEND,
    changeOrigin: true,
    xfwd: true
  },
  '/socket.io': {
    target: BACKEND,
    changeOrigin: true,
    xfwd: true,
    ws: true            // WebSocket 升级
  }
};

export default defineConfig({
  plugins: [react()],

  // [SEC] 构建产物不产出 source map：`.map` 一旦被托管出去，
  //       等于把未混淆源码连同开发者本地路径一起公开（Vite 默认已是 false，
  //       这里显式写出来，避免以后被人改回去）。
  build: {
    sourcemap: false,

    // 本项目打包后主 chunk 约 530KB（gzip ~157KB），超过 Vite 默认的
    // 500KB 阈值会打一条 "Some chunks are larger than 500 kB" 警告。
    // 这不是错误，只是提示；调高阈值消掉噪音。
    // 真要减小体积应该用 React.lazy 做代码分割（把商城 / 管理面板 /
    // 插件管理等打开才用的页面拆出去），对内网/局域网场景收益不大。
    chunkSizeWarningLimit: 600
  },

  // 开发用 dev server：默认只绑回环；`npm run dev:lan` 才对外（会泄露源码）
  server: {
    host: DEV_HOST,
    port: 5173,
    strictPort: true,

    // 禁止读取工程根目录之外的任意文件（Vite 任意文件读取类漏洞的兜底）
    fs: {
      strict: true
    },

    // 编辑器 / 工具常把改动先写成 .index.css.<pid>.<uuid>.tmpdir/xxx.tmp，
    // 这类临时目录落在被监听的源码树里会让文件监听抛 EBUSY，
    // 直接把 dev server 打挂（之后页面就会一直报 socket.io 连不上）。
    watch: {
      ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/*.swp', '**/*.swx']
    },

    proxy: PROXY
  }
});