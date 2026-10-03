# DEVLOG · realtime-chat

> 给 AI 的压缩日志：只留**结论 / 根因 / 一行修法**。改代码前先读 §0 §2。
> 栈：client = Vite8 + React19（无路由库，自写视图路由）；server = Express + node:sqlite + Socket.IO；端口 5173 / 3001。
> 逐条可复查的缺陷清单（编号 / 严重级 / 位置 / 现象 / 根因 / 修法 / 状态 + 误报备查 + 验证证据）见 **`ERRORLOG.md`**。
> 说明：项目**没有运行期日志文件**（无 `.log`、无 `uncaughtException` / `unhandledRejection` 兜底），错误仍走散落的 `console.error`。

## 0 现行架构（勿回退）

| 位置 | 职责 |
| --- | --- |
| `client/src/components/chat/ChatRoom.jsx` | 唯一编排：`view`(str) + `tab` + `viewNonce` 路由；socket 逻辑 |
| `client/src/components/nav/SideNav.jsx` | 左侧统一导航：76px 细条 ↔ 悬停展开 236px，hover 出 `.nav-flyout` 子功能 |
| `client/src/components/chat/ListPanel.jsx` | 会话/联系人/群聊列表（仅 chat 视图，**常驻显示，不可折叠**） |
| `client/src/components/common/Avatar.jsx` | 全站唯一头像组件：**方形圆角（半径 = 尺寸 × 0.3）**，图片 / emoji / 首字母三态 |
| `client/src/components/common/Icon.jsx` | 内联 Lucide 图标 22 个，零依赖 |
| `client/src/components/admin/adminTabs.js` | 管理页签唯一来源 `adminTabsFor(can)`，导航菜单与面板共用 |
| `client/src/styles/index.css` | 骨架类：`.app/.app-body/.sidenav/.nav-item/.nav-row/.nav-flyout/.panel/.view` |
| `client/public/logo.jpg` | 站点图标（`index.html` favicon）+ 导航栏品牌图标的唯一来源；改图只改这一个文件 |
| `server/src/services/rooms.js` | 公共聊天图标：`room_settings` 表，能力位 `manage_public_room`（100＝开发者） |
| `server/src/utils/ip.js` | **来源 IP 的唯一出口**（`clientIp()`）：默认只认 TCP 对端，反代后才读 XFF 且取**最后一段**。IP 绑定 / 失败次数 / 审计日志都必须走它（§1.36/47） |
| `client/src/utils/image.js` | **图片上传前的唯一入口**（`prepareImage()`）：按 EXIF 方向解码 → 限长边 → 重编码（透明留 PNG，否则 JPEG）。所有上传 API 都经它，组件别自己 append 文件（§1.55） |
| `client/src/components/common/FileTypeIcon.jsx` | **文件类型图标的唯一来源**：11 类 SVG（品牌路径来自 simple-icons CC0）+ 纯函数 `fileKind(name, mime)`。别再写第二套字母方块（§1.60） |
| `client/src/utils/fileTypes.js` | **文件类型注册表**：内置 11 类 + 开发者自定义（`config.yaml → files.types` 经 `/api/file-types` 下发，自定义优先）。`fileKind()` 在这里；异步拉取后用 `useSyncExternalStore` 通知重画（§1.64/65） |
| `client/src/components/common/MediaPreviewModal.jsx` | 通用预览浮层：图片 / 视频 / 音频 / PDF（iframe）/ 文本（200KB 上限）。父组件负责取 Blob 与 revoke（§1.60）。试看图走 `ProtectedImage`、视频/音频拦右键（§1.75） |
| `client/src/components/common/ProtectedImage.jsx` | **受保护图片（防顺手另存）的唯一渲染入口**：`contextmenu` / `dragstart` 双拦 + `draggable=false` + 透明盾 + 禁选中。用在商城试看图、详情页图集、**首页卡片封面**上；聊天图片别用（那边要能存）。**它不是安全边界**（§1.75/77） |
| `client/src/utils/captureGuards.js` | **两道防抓取守卫**：键盘（F12 / Ctrl+Shift+I·J·C / Ctrl+U / Ctrl+S）+ **全站右键菜单**（只 `preventDefault`，自定义菜单与输入框粘贴不受影响）。**只在生产构建安装**、`?dev=1` 可跳过（§1.78/79） |
| `server/src/services/transcode.js` | **音视频转码的唯一实现**：ffprobe 判「容器 + 编码」→ 计划（`none`/`remux`/`transcode`）→ 后台队列 ffmpeg → 副本落 `uploads/<子目录>/tc/<同名>.mp4\|.m4a\|.mp3`（**原件一律不动**）。`describe()` 幂等入队（§1.68/69/70） |
| `server/src/routes/media.js` | 转码状态口：`GET /api/media/status?src=`（顺带入队 → 历史附件自愈）+ `GET /api/media/transcode`（诊断 ffmpeg 是否就绪） |
| `client/src/api/mediaApi.js` | 前端唯一的转码状态入口（`getMediaStatus`）：`MessageBubble` / 商品详情据此决定「原地址播、等转码、还是退回卡片」 |
| `client/src/components/chat/MessageBubble.jsx` | 媒体播放状态机 `direct → waiting → play / fallback`（§1.70）：转码中显示进度条，转好自动换播放器，救不回来才退卡片 |
| `server/scripts/transcode_check.mjs` | 音视频转码回归（137 项）：用**本机 ffmpeg 现场造素材**，自包含隔离实例 |
| `server/scripts/sticker_pack_check.mjs` | 表情包系统回归（`npm run test:stickers`）：表情包 CRUD / 批量上传（≤50 张 / ≤10MB 单张）/ 排序 / 分享码 / 订阅（只建关联、不复制文件）/ `GET /api/stickers/lookup` 反查（B1 依赖它）。**项数与是否自包含待实测后补登**（脚本存在于 2026-09-27，早于本轮） |
| `server/scripts/plugin_check.mjs` | 插件系统回归（`npm run test:plugins`）：manifest 校验 / 打包解包 / 安装授权 / 卸载 / KV 配额 / 分享码订阅 / 票据（申请-使用-过期）/ 支付幂等与退款 / 权限白名单 / 管理接口。**项数与是否自包含待实测后补登**（脚本存在于 2026-09-28，早于本轮） |
| `server/src/auth/loginGuard.js` | 登录失败限流：IP + 账号双维度滑动窗口（`config.yaml → rate_limits.login`），超限 429（§1.48） |
| `server/src/db/schema.js` | 建表分两段：**给新表补列的 `addCol` 必须放在文件末尾**（§1.50，放错只有全新库会崩） |
| `server/src/app.js` | 末尾的静态托管段：**必须在 `/api` 路由与 `/api` 404 之后**，且 fallback 排除 `api\|uploads\|socket.io\|health`（§1.53） |
| `server/scripts/static_host_check.mjs` | 单端口托管回归（20 项）：隔离实例 + 临时空库，验证产物托管、不泄源码、接口不被前端吃掉 |
| `server/scripts/security_check.mjs` | 安全控制回归（29 项）：自包含隔离实例 + 临时空库，不需要先起服务，也不碰 `chat.db` |
| `server/scripts/image_check.mjs` | 前端图片规范化回归（15 项）：无头 Edge 跑真实 `utils/image.js`（EXIF 方向 / 压缩 / HEIC 报错） |
| `server/scripts/upload_format_check.mjs` | 上传格式白名单回归（25 项）：自包含隔离实例，钉住「该收哪些、该拒哪些、文案说什么」 |
| `client/src/api/stickersApi.js` | 表情包 API 封装；`lookupSticker(token, url)` 反查「这个表情属于哪个包 / 我是否拥有 / 对应商品 id」（§1.80） |
| `server/src/auth/tokens.js` + `cookies.js` + `services/refreshTokens.js` | **双 token 认证的唯一实现**：Access（JWT 15m，前端内存）+ Refresh（随机串 30d，HttpOnly Cookie，Path=/api/auth）。轮换 + 重放检测（用已撤销的 token 刷新 = 整族作废）。**认证相关的改动一律先读这三个文件的顶部注释** |
| `server/src/auth/tokens.js` + `server/src/auth/cookies.js` + `server/src/services/refreshTokens.js` | **双 token 认证的唯一实现**：Access（JWT 15m，前端内存）+ Refresh（随机串 30d，HttpOnly Cookie，Path=/api/auth，SameSite=Strict）。Refresh 只存 SHA-256、每次刷新轮换、检测到重放整族作废。前端唯一持有者是 `client/src/auth/session.js`；`client/src/api/http.js` 在 401 TOKEN_EXPIRED 时自动刷新 + 重放一次。**认证相关的改动一律先读这三个文件的顶部注释** |
| 已删除（历史方案） | `ChatSidebar.jsx`（竖排按钮条）、`TopNav.jsx`（顶部栏） |

三个关键机制：

- **弹窗→整页**：各 `*Modal` 组件源码未改，靠 CSS 摊平（§1.3）。
- **视图重建**：`openView()` 每次 `setViewNonce(n+1)`，`<section className="view" key={view+"-"+viewNonce}>`。
- **权限**：`server/src/services/permissions.js` → `can(role,cap) = level(role) >= CAPABILITIES[cap]`，developer 恒 true；改 `server/config.yaml` **必须重启后端**。

## 1 踩过的坑

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 头像/div 放进导航按钮报非法嵌套 | `<button>` 只允许 phrasing content | `Avatar` 根节点 div→span（`.avatar` 本就 `display:flex`，无视觉变化） |
| 2 | 弹窗内嵌成整页后仍缩在中间 640px | 弹窗自带 `max-width:NNNpx !important`（`.ap/.ak/.ast/.stk-modal`、`.admin-panel`） | 覆盖必须同级 `!important`：`.view > .modal-overlay > .modal-card{width:100%!important;max-width:none!important}` |
| 3 | 同一入口点两次「没反应」 | `key={adminTab}` 不变→不重建，组件内部状态残留 | `viewNonce` 递增进 key |
| 4 | 靠底部的浮窗越出视口 | 只按 item 的 `top` 定位 | 量空间翻转：`spaceBelow<380 && spaceAbove>spaceBelow` → 用 `bottom` 锚定 |
| 5 | 浮窗被裁切 | 挂在 `overflow-y:auto` 的 `.sidenav-body` 内 | 浮窗挂 `.sidenav` 直属子节点（overflow visible），`top` 由 item 相对 rail 算 |
| 6 | 触屏点不出子功能 | 交互只有 hover | `matchMedia('(hover: hover)')` 分叉：桌面 hover 展开/点击进入；触屏点击展开、再点进入；≤768px 浮窗 `position:fixed` 贴边 |
| 7 | 管理菜单里有点不动的页签 | 菜单硬编码 5 项，角色只有 2 项 | 统一走 `adminTabsFor(can)` |
| 8 | 管理员看不到「API 密钥」 | `manage_apikeys: 90` > admin(50) | config 改 `50`；重启后端 |
| 9 | **dev server 无故退出，页面持续报 socket.io 连不上** | 编辑器/工具原子写产生 `.{file}.{pid}.{uuid}.tmpdir/*.tmp` 落在监听树 → chokidar `EBUSY` → 未捕获 error 杀进程 | `vite.config.js`：`server.watch.ignored:['**/.*.tmpdir/**','**/*.tmp',...]` |
| 10 | `favicon.ico 404` | 无图标 | `index.html` 内联 SVG data URI |
| 11 | 中文源码被写坏成乱码 | PowerShell `Set-Content -Encoding utf8` 按 GBK 读 | **禁止用 shell 改含中文的源文件**，一律用编辑工具 |
| 12 | `node -e` 里 SQL/引号被 PowerShell 吞 | 多层引号转义 | 写临时 `.cjs` 脚本执行 |
| 13 | 启动报 `EADDRINUSE :3001` | `job_kill` 只杀 pwsh 包装，node 子进程存活继续占端口 | 按 PID 查 `Get-CimInstance Win32_Process`（看 CommandLine/CreationDate）再 `Stop-Process` |
| 14 | 可能误杀用户进程 | 端口/浏览器进程可能属于用户 | 只按特征清理（如 `--headless=new`）；用户自己的服务不动 |
| 15 | CDP 悬停不触发 | 同坐标重复 `mouseMoved` 不产生 mouseenter | 先移到空白再移回目标 |
| 16 | 触屏模拟无效 | `matchMedia` 在组件挂载时求值 | 先 `setTouchEmulationEnabled`+`setDeviceMetricsOverride`，再 reload |
| 17 | 提权后 socket 仍报无权限 | `socket.user` 是**连接时**的快照（`loadUser` 只在握手时跑） | 测试里提权后必须重连；REST 每请求重查所以不受影响 |
| 18 | 群成员列表里管理员排最后 | `ORDER BY m.role DESC` 是字典序（owner > member > admin） | 改显式 `CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END` |
| 19 | 上传路径校验被绕过：`/uploads/../uploads-old/x.png` 逃出 uploads 根 | `abs.startsWith(root)` **没带路径分隔符**，`uploads-old` 与 `uploads` 前缀相同 | 统一用 `assets.isInsideDir()`（带 `path.sep`）+ 逐段拒绝 `.` / `..` |
| 20 | 卖家可把任意文件挂成商品，买家购买后出现在**公开可读**目录 | 商品文件的 `f.url` 完全由客户端提供，除 `absFromUrl` 外无归属 / 存在性校验 | 上架时强制「落在 `uploads/shop` 内且真实存在」；`grantFromProductFile` 再加一层 SHOP_DIR 限制 |
| 21 | 「我购买的」下载按钮永远不出现 | 前端读 `o.fileUrl`，但 `/shop/orders` 根本没下发该字段（商品文件也不该给裸链） | 接口补 `fileId/fileName/fileCount`，前端改走鉴权下载 `downloadFile()` |
| 22 | 免费商品在管理端无法定价上架 | `AdminReviewTab` 卡 `price < 1`，而 `config.yaml` 是 `price.min: 0`、FEATURES 写明「审核时可定价为 0」 | 前端放宽到 `0`，与后端 `reviewOfficialPrice` 对齐 |
| 23 | 各类限流 `Map` 长期运行内存只增不减 | 按 keyId / IP / userId 存的数组只过滤不删键，也没有整键清理 | 加 `prune()` + `unref()` 定时器（每 500 次操作或 5 分钟）；下载限流超限时也要**写回**裁剪后的数组 |
| 24 | 未匹配的 `/api/*`、未捕获异常返回 HTML | 既没有 404 兜底也没有错误中间件 | 挂 `/api` 级 JSON 404 + 全局 JSON 错误处理；**不要加全局 catch-all —— 会吃掉 `index.js` 里后注册的 `/health`** |
| 25 | `new RegExp(undefined)` 静默变成 `/undefined/` | `security.blocked_ext` 缺失 / 非法时没校验，会误拦名字含 "undefined" 的文件 | 启动时校验类型，编译失败直接抛错；关键子配置补默认值 |
| 26 | 官方系统账户的锁定哈希靠手搓 `$2a$10$` + base64 | 该账户是 `developer`，哈希格式一旦不合规，行为取决于 bcrypt 实现细节 | 改 `bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10)` |
| 27 | `npm run lint` 全项目飘红 | eslint-plugin-react-hooks v7 新增 `set-state-in-effect`，把「挂载后拉一次数据」一律判 error（本项目一直都是这个写法） | 该规则降级为 `warn`（保留提示）；另清掉 2 处真·未使用变量 |
| 28 | 商城搜索框每敲一个字打一次接口 | `keyword` 直接进 `load` 依赖 → 每次输入都 refetch，响应乱序时旧结果覆盖新结果 | 输入与查询分离：`keyword` 防抖 300ms 写入 `query`，回车立即生效 |
| 29 | 消息附件可带任意 URL（`javascript:` / `data:` / 外链） | 只有表情消息校验 `/uploads/`，普通 `fileUrl` 直接入库，前端又把它渲染成可点击的 `<a href>` | `sendMessage` 统一白名单：只收 `/uploads/[A-Za-z0-9_\-./]+`、拒 `..`、≤500 字符；`fileName`/`fileType` 一起截断 |
| 30 | **改一次昵称 / 头像就把整个后端打崩**（全站掉线） | `registry.js` 的 `onlineUsers` 是**模块私有** Map、只导出 getter `getOnlineUsers()`，但 `socket/index.js` 写成解构 `const { onlineUsers } = registry` → `undefined`；`presence.js` 的 `user:refresh` 一执行就 `TypeError`，而 socket handler 是唯一**没有**异常兜底的入口 → `uncaughtException` → 进程退出 | 改用 `registry.getOnlineUsers()`；`socket/index.js` 给每个 handler 统一包 try/catch（安全网，新增处理器自动受保护） |
| 31 | 任一登录用户发**一个**畸形包即可打崩服务 | 25 个 socket handler 大多写成 `({ x })` 没有默认值；`emitTyping` 直接假设 `roomId` 是字符串，`roomType:'private'` 且缺 `roomId` 就抛 | 全部补 `= {}`；`emitTyping` 增加 roomType/roomId 类型校验 |
| 32 | 预期内的 4xx 也打完整堆栈，真异常被淹没 | 路由 catch 不区分「用户输入错误」与「服务端异常」 | 未改（属运行期日志范畴）：建议 4xx 记单行 warn、仅 5xx 记堆栈 |
| 33 | 「最近会话」浮层里**群图标太大 / 缩放不对**（图片被拉成又宽又大的块），行内状态点也被撑宽 | `.nav-row > span { flex:1 }` 想命中文字标签，却把 **`Avatar` 的根节点（就是 `<span>`）** 和 `.dot` 一起命中了；`flex` 简写令 `flex-basis:0%`，**flex-basis 非 `auto` 时压过内联 `width:28px`** | 收窄为 `span:not(.avatar):not(.dot)`，并显式 `.nav-row > .avatar, .nav-row > .dot { flex: 0 0 auto }` |
| 34 | 个人信息页的 emoji 网格**摊满整屏**（按钮 160×160，很散） | 弹窗转整页把 `.view > .modal-overlay > .modal-card` 设成 `width:100%!important`；`AvatarEditor` 的 `.avatar-grid` 直接放在该 card 里、**没有限宽**，而群图标那边有 `.room-icon-editor{max-width:520px}` 兜着 | 新增 `.avatar-editor` 容器，与 `.room-icon-editor` **共用同一组限宽 / 面板 / 居中样式** |
| 35 | 个人信息页提示「支持 SVG」，但选 SVG 必被拒 | 服务端 `middleware/upload.js` 明确拒绝 `image/svg+xml`，`allowed_ext` 也不含 `.svg`；只有前端文案没跟上 | 文案改为「PNG / JPG / GIF / WebP（≤5MB）」 |
| 36 | **`X-Forwarded-For` 被无条件采信** → IP 绑定与暴力枚举防护**同时**失效 | `utils/ip.js` 直接读 XFF，而它既是 `apikey_ip_claims` 的键、又是 `ipFailures` 的键。PoC：只改一个请求头就绕过「同一 IP 只能绑一个用户」；轮换 XFF 连失 45 次**全程不触发 429** | 加 `security.trust_proxy`（默认 `false`）；`app.set('trust proxy', …)`；只在信任代理时才读 XFF，否则用 `req.ip`；`download.js` 自读 XFF 的实现删掉改共用 |
| 37 | 局外人能拉走**任意群**的完整成员名单 | `getGroupInfo` 只查群是否存在、无成员校验，返回体却含 `members`（用户名/昵称/头像/角色） | 非成员且非群主 → 403（发现群聊走 `searchGroups`，不受影响） |
| 38 | 任何人可伪造别人私聊的「已读」回执 | `markRead` 没校验调用者是该私聊参与者，直接写 `message_reads` 并广播 | 解析 `p_a_b` 并校验 `parts.includes(user.id)` |
| 39 | 任何人可向**任意两人**的私聊注入「正在输入」 | `emitTyping` 私聊分支只拆 `roomId` 群发，漏了成员校验（群聊分支有 `isGroupMember`） | 私聊分支同样校验 `parts.includes(user.id)` |
| 40 | 商品 / 表情包封面地址零校验 | `cover_url` 客户端直传、原样入库并回吐给前端 `<img>` | 新增 `utils/url.js` 的 `normalizeImageUrl()`，两处统一收口 |
| 41 | **仓库里写死了真实特权账号的明文密码** | `init_accounts.py` 硬编码 admin（`党的好干部`）与 developer（`狐本无忧`）的密码，docstring 与收尾还打印出来；这两个账号就是当前 `chat.db` 里的真实账号 | 改读 `INIT_ADMIN_PASSWORD` / `INIT_DEV_PASSWORD`，缺失则随机生成并**只打印一次** |
| 42 | 自检脚本会**删真实数据**并留特权残留 | `smoke_test.mjs` 无条件 `DELETE FROM apikey_ip_claims`（全表！）且提权后不还原；`socket_check`/`room_icon_check` 无条件删 `room_settings` 的 public 行（= 清掉使用者设的公共聊天图标） | 全部收窄到本套测试账号；`room_settings` 改「测试前快照 → 收尾还原原值」；补角色还原与密钥撤销。**本轮实测踩中过，已还原** |
| 43 | Python 脚本在 stdout 被重定向时崩溃退出 | GBK 控制台打印 ⚠ / ✓ 抛 `UnicodeEncodeError` 并以 exit 1 中断，CI / 日志重定向全不可用 | `clean_history.py` / `init_accounts.py` / `scaffold.py` 均加 `sys.stdout/stderr.reconfigure(encoding='utf-8', errors='replace')` |
| 44 | **dev server 绑 0.0.0.0 → 完整源码 + source map 泄露**（外部渗透报告 F-01，还原出 55 个源文件） | `client/vite.config.js` 写死 `host: '0.0.0.0'`。dev 模式下 Vite 直接托管整个工程目录，模块内联 base64 source map 的 `sourcesContent` 就是未压缩原文；`/package.json`、`/vite.config.js`、`/package-lock.json` 也能直接下载 | `host` 改 `process.env.VITE_DEV_HOST \|\| '127.0.0.1'`（要局域网访问必须显式开）；显式 `build.sourcemap: false`；补 `server.fs.strict: true` |
| 45 | 后端 `3001` 对局域网裸奔，可绕过 Vite 代理 | `server.listen(port)` 不传 host = 绑 `0.0.0.0`，而 `config.yaml` 里**没有 host 这一项** | 新增 `server.host`（默认 `127.0.0.1`）+ 环境变量 `HOST`；`index.js` 显式 `listen(PORT, HOST)`；`config.js` 兜底也钉死回环，**绝不兜底成 0.0.0.0** |
| 46 | **密钥 `boundIp` 只记录不校验**（F-03），IP 绑定形同虚设 | 申请时写进响应就完事，使用时一次都没比对 | 迁移加 `api_keys.bound_ip`；`authenticateApiKey` 每次强制比对，不一致 403 + 审计；遗留密钥（NULL）首个请求就地补写 |
| 47 | 信任代理时取 `X-Forwarded-For` 的**第一段**，方向取反 | 反代（Vite `xfwd` / nginx）是把真实对端**追加到末尾**，第一段是客户端可随手伪造的值。取第一段 = 自己把伪造值当身份 | 先直接用 Express 算好的 `req.ip`；只有 socket 握手这种没有 `req.ip` 的伪造 req 才手工解析，且取**最后一段** |
| 48 | 登录接口零限流，可无限爆破（F-04） | `POST /api/auth/login` 没有任何计数 | 新增 `auth/loginGuard.js`：IP + 账号双维度滑动窗口，超限 429 + `Retry-After`；成功清账号计数（**保留** IP 计数）；判定排在 bcrypt **之前** |
| 49 | `/api/v1/state` 与 `users:online` 把**全站在线用户**（含 username）发出去（F-05） | `registry.onlineList()` 无可见性概念，广播也是 `io.emit` 全局 | 只留 `id/nickname/avatar`；按 `relatedUserIds()`（自己 + 好友 + 同群）收敛；广播改逐连接下发子集；留 `security.presence.scope` 开关 |
| 50 | **给新表补列的 `addCol` 放在建表之前 → 全新库启动直接崩**（`no such table: api_keys`） | `schema.js` 的「老库补列」区跑在第二个 `db.exec()`（建 `api_keys` 等新表）**之前**；老库因为表已存在完全看不出来，只有新部署会炸 | 这类补列一律写到 `setupSchema` **末尾**；由新写的隔离实例用例（`security_check.mjs` 用临时空库起实例）当场抓住 |
| 51 | 自检脚本残留账号（TEST-1），渗透测试也留下**仍然有效的密钥** | 脚本收尾只释放绑定/还原角色，从不删自己建的账号；`sectest_*` / `massign_*` + 3 把有效密钥 + 2 条 IP 绑定 + 1 条待审提权申请一直躺在库里，把 `smoke_test` 顶成 403 | 新增 `scripts/cleanup_test_data.mjs`（默认演练、`--apply` 才删、拒绝 id ≤ 3、路径逐段校验） |
| 52 | **只把 dev server 改回环，等于没修**：局域网共享是真实需求，使用者只会自己把 `0.0.0.0` 开回去 | 原先只有「dev server 对外」（泄源码）与「只给自己用」两条路，没有「对外但不泄源码」的路 | 后端托管前端产物（单端口）：`config.yaml → client.serve/dist` + `app.js` 静态托管 + SPA fallback，`npm run start:lan`；命令行 `--host/--port` 跨平台改监听地址（PowerShell 的 `VAR=x cmd` 不成立） |
| 53 | 单端口托管**挂载顺序写错会静默出事** | 静态文件/SPA fallback 若挂在 `/api` 之前 → 接口返回 HTML；`/health` 在 `index.js` 里后注册 → 被 fallback 吞掉（§1.24 同源）；`/uploads` 未命中不该回落 index.html | fallback 显式排除 `api|uploads|socket.io|health`，并钉进 `scripts/static_host_check.mjs`（20 项） |
| 54 | `job_kill` 只杀 pwsh 包装，**node 子进程继续占端口**（§1.13 复发） | 同一个 3001 上出现两个 LISTENING（`0.0.0.0` 新实例 + `127.0.0.1` 旧实例），Windows 下更具体的 `127.0.0.1` 优先 → 回环请求打到旧进程，测试出现假失败 | 按 PID 核 `Get-CimInstance Win32_Process` 的 CommandLine/CreationTime 后 `Stop-Process`；**收尾必须确认端口真的空了**，别只信 job_kill |
| 55 | **手机照片传不上去 / 更多图片格式不支持**（用户反馈）：iPhone HEIC 直接拒、6MB 直出照撞「头像不能超过 5MB」、AVIF 拒、手机相册里选不到照片 | 上传前**没有任何图片处理**：不压缩（手机直出 3–12MB vs 头像上限 5MB）、不处理 EXIF 方向、白名单只有 4 种且两处不一致；三处 `<input accept="image/png,image/jpeg,...">` 还把手机选择器限死（HEIC 照片直接置灰） | 新增 `client/src/utils/image.js`：上传前统一「按 EXIF 方向解码 → 等比限长边 → 重编码」（有透明留 PNG，否则 JPEG）。实测 10.90MB/4000×3000 → **0.13MB/1024×768**，EXIF=6 输出竖图。白名单统一 PNG/JPG/JPEG/GIF/WebP/**BMP/AVIF**、头像上限 5→8MB、`accept` 改 `image/*` |
| 56 | HEIC 传不了，但又**不能**简单地把 HEIC 加进白名单 | 桌面 Chrome/Firefox/Edge 渲染不了 HEIC/TIFF —— 收下来就是一张裂图 | 分两路：手机浏览器能解码 → 客户端**转成 JPEG**（所以手机上传正常）；桌面解不开 → 抛 `UNDECODABLE` 并给出可执行做法（相册另存为 JPEG / 相机格式改「兼容性最佳」）。服务端**继续拒** HEIC/HEIF/TIFF（§11.2 IMG-8） |
| 57 | 拒绝文案会随着白名单改动而漂移 | 「只支持 PNG / JPG / GIF / WebP 图片」是硬编码字符串，加格式时必然忘改 | 文案改成**从白名单现算**（`UNSUPPORTED_MSG` / `AVATAR_FORMAT_MSG` / `ASSET_FORMAT_MSG`），并钉进 `upload_format_check.mjs` |
| 58 | 前端前置体积校验把「还没压缩」的原图拦掉了 | `StickerPackManager` 在压缩**之前**判 `>10MB` 就 alert 返回，12MB 手机照片根本走不到压缩 | 前置阈值改成「原图 ≤40MB」，真正的上限交给压缩后 + 服务端 |
| 59 | 报告说「上传按文件魔数校验」，实际**根本没有魔数校验** | `grep magic\|sniff` 无命中、依赖里无图片库；实际判定是**扩展名 + MIME**。结论（.html/.svg 被拒）对，机制说错了 | 记录在案，避免以后按错误认知做设计（真要防伪装文件得自己加魔数校验，目前**没有**） |
| 60 | 视频 / 音频只能当文件下载，**没有内联播放**；文件图标是字母方块；商品「预览」是个空壳（勾了只显示一行「可预览」，前端从不调那个接口） | `/api/file` 只分 `image`/`file` 两类；图标是 `getFileMeta`/`getShopFileIcon` 两套字母方块；`/api/shop/preview` 服务端早就有了但前端从未调用 | 附件按 MIME 分 `image/video/audio/file`；视频 `<video preload=metadata>`（不自动播放）、音频 `<audio>`，**播不了就退回卡片**；新增 `FileTypeIcon.jsx`（simple-icons CC0 路径内联，零依赖）；`shopApi.previewFileBlob()` + `MediaPreviewModal` 把试看真正接上（未购买也能看，下载仍需购买）；详情页做成京东式图集（封面 + 勾了预览的图片/视频，**复用 `is_preview`，不改库**）|
| 61 | UI 回归脚本两次踩坑：内联 `<script type="module">` 里的 JSX 让 Vite 返回 **500**；跨源 POST 回环地址被 Chromium 拦截 | ① Vite 把 HTML 内联脚本抽成 `.js` 传给插件链，JSX 解析失败；② Chromium 的本地网络访问限制（Local Network Access）会拦「A 源页面 → B 源回环端口」的请求 | ① 断言逻辑拆成独立 `.jsx` 模块；② 页面与结果回收口**必须同源**（用一个同源反代把 Vite 包住）；另外资源加载失败不冒泡，捕获阶段要 `e.message` 判断，别把故意制造的 404 当成测试崩溃 |
| 62 | 撤回只把 text 改成 `'[消息已撤回]'` 留占位行，用户要的是**直接删除** | 占位方案要在库里留垃圾行、前端还得为它写一套特殊渲染；而撤回的语义本来就是「这条消息不存在」 | 服务端 `DELETE` 消息 + 已读回执（仍广播 `message:recalled`），前端收到就从列表 `filter` 掉；`isRecalled` 分支 / `.message.recalled` 样式 / 右键菜单特判全部删掉（都成了死代码） |
| 63 | 改完撤回，历史里的旧占位行会**以 `[消息已撤回]` 原始文本显示出来** | 前端不再有占位渲染，但老库里还留着旧实现写的占位行（前几轮测试与真人使用留下的） | `schema.js` 末尾加**一次性数据清理**（连同 `message_reads`，幂等）；这是「改语义必须同时管老数据」的典型 —— 由 `socket_check` 新增的断言当场抓出来 |
| 64 | 文件类型表**硬编码在组件里**：开发者遇到新类型（.psd/.apk…）只能改源码 + 手搓 SVG + 重新构建前端 | `FileTypeIcon.jsx` 同时持有归类表与画法，且为了同时导出 `fileKind` 与组件还得挂一条 `eslint-disable react-refresh/only-export-components` | 类型表搬到 `utils/fileTypes.js`（**内置 11 类 + 后端下发的自定义类型，自定义优先**）；`config.yaml → files.types` 让开发者配 `key/label/color/exts/cover`；`GET /api/file-types` 下发 → 改配置重启即生效、**不用重新构建前端**；`fileKind()` 移出组件后那条 eslint-disable 也去掉了 |
| 65 | 类型注册表是**异步**拉回来的，但图标是同步渲染的 → 屏幕上的图标不会自己更新 | `FileTypeIcon` 是纯函数组件，注册表更新不会触发重渲染 | 注册表加 `subscribe/version`，组件用 `useSyncExternalStore` 订阅 → 拉到之后**已渲染的图标自动重画**（前端 harness 专门验证了这条链路） |
| 66 | 自定义类型的默认 `label` 是小写（`apk`），而内置角标都是全大写（`PDF`/`ZIP`） | `config.js` 里 `label` 缺省写了 `key` 而不是 `key.toUpperCase()` | 改成大写缺省；由 `file_types_check.mjs` 的断言抓出 |
| 67 | 封面 `<img>` 只用样式设了尺寸，没给 `width/height` **属性** | 只设样式时浏览器无法提前占位，图片加载完会造成布局抖动 | 属性与样式都给（属性占位、样式缩放）；由前端 harness 的断言抓出 |
| 68 | 接上 ffmpeg 后**每一个转码任务都失败**：`ffmpeg 退出码 4294967274：Error opening output files: Invalid argument` | ffmpeg 按**输出文件的扩展名**推断封装格式，而原子落位要求先写 `*.part` —— 未知扩展名 → 找不到可用封装器。注意退出码是 4294967274（＝ `-22` EINVAL 的无符号形式），不是「权限」之类 | 输出参数里显式 `-f mp4` / `-f mp3`（`m4a` 用 `-f mp4` 就够，别去猜 `ipod`）。写 `*.part` 本身要保留：静态目录里绝不能出现半截 mp4，浏览器会拿到「播到一半戛然而止」的文件，比播不了更糟 |
| 69 | 按**扩展名**判「浏览器能不能播」会判反 | 浏览器认的是**容器 + 编码**的组合，不看文件名：`.mp4` 里装 HEVC 扩展名完全合法却播不了；`.mkv` 装 h264+aac 扩展名不合法、换个壳就能播。反过来只看编码也会漏掉容器 | 判定输入一律来自 ffprobe 的 `codec_name` + 扩展名双看：mp4/mov 只认 h264(+aac/mp3)、webm 只认 vp8/vp9/av1(+opus/vorbis)，音频按 mp3/m4a/ogg/flac/wav 分别判。两个反例（HEVC-in-mp4、h264-in-mkv）都写成断言 |
| 70 | 转码接上后，「`onError` 就退回文件卡片」反而变成**误导**：明明正在转 / 已经转好，用户看到的是「浏览器无法直接播放」 | 回退是本地播放器事件驱动的，客户端根本不知道服务端能不能转 | 加播放状态机：`onError` 先问 `/api/media/status`（后端可能已有副本，或当场入队），只有后端也救不了才退卡片；扩展名一看就不行的（mkv/avi/wma…）直接进等待态，省掉一次注定失败的加载。**历史附件靠同一条链路自愈**（第一次被播放时入队转码） |
| 71 | 跑完 `smoke_test` 后服务端日志冒出两条 `[transcode] 失败：…mp4 / …mp3 —— ffmpeg 退出码 69` —— **不是 bug** | 该套件的上传用例是**一张 84 字节的 1×1 PNG 冒充 `.mp4`/`.mp3`**（`mimetype` 写的是 `video/mp4`）。ffprobe 认得出里面是 `png` 视频流 → 判定「要转码」，ffmpeg 真去转时解不出帧 → 失败 → 客户端退回文件卡片（与旧行为一致） | 保持现状：文件本身就是坏的，退回卡片就是正确结果，失败会记进 `failures` 表、同一进程内不反复重试。**别**为这几行日志加「体积太小就不转」之类的特判 |
| 72 | 探测写成 `spawnSync` 时，一个畸形文件就能**把整个后端按住**（最长 `probe_timeout_ms`），期间所有请求与 socket 心跳全停 | `spawnSync` 阻塞事件循环，而探测在请求路径上（上传接口要当场回计划） | 探测改异步（`spawn` + Promise，超时 kill）；只有启动期的 `ffmpeg -version` 仍用同步调用（一次性、几十毫秒、有缓存） |
| 73 | **清理「无引用文件」时把正在用的公共聊天图标删成了裂图** | 我手工写的孤儿扫描只列了「显式存 URL 的字段」，**漏了 `room_settings.icon`**（还有 `user_preferences.background`、`bubble` 主题 JSON、`groups.avatar` 这类藏在文本/JSON 里的路径）。那个文件看起来确实「没人引用」：它是用户 2 的头像，被公共图标复用 | ① 已恢复该文件（同账号同尺寸的头像副本）；② 引用面改**动态穷举**：遍历 `sqlite_master` 所有表、把每行 JSON 里的 `/uploads/` 路径全抠出来；③ 清理工具**删文件前再查一遍全库引用**，仍被引用的一律保留；④ 新增 `cleanup_orphan_files.mjs`（默认只演练）替代手搓脚本。**教训：只要涉及删文件，引用面永远不要手列字段** |
| 74 | 跑一轮自检就在**真实库**里沉淀一批账号 + 孤儿文件（本轮实测 11 个账号、64 个无引用文件） | 三个自检脚本收尾只释放 IP 绑定 / 还原角色，**从不删自己建的账号**（TEST-1 一直挂着 ⚠️）；`cleanup_test_data.mjs` 又只删「目标账号名下那些行引用到的文件」，没挂到任何行上的上传（没发送的附件、`uploads/tmp/*`、已删账号的旧头像）不在它视野里 | **已根治**：新增 `scripts/lib/cleanup_accounts.mjs`，三套脚本跑完自动 ① 删本套账号（复用 `cleanup_test_data.mjs`，含名下数据与文件）② 按跑前快照清**本次新产生且无人引用**的上传文件；`--keep` 保留现场。另外新增 `cleanup_orphan_files.mjs`（全局孤儿清理，默认只演练）供手动兜底。实测三套重跑后：账号 0 残留、孤儿 0 个 |
| 75 | 「**防止用户右键下载预览图**」这个需求里，前端能做的与做不到的必须分开说 | 试看图是「登录即可拉」的响应（§1.60），出口有四条：右键另存 / 拖拽（前端能拦）、开发者工具与网络面板（拦不住）、拿 token 直接打接口（前端管不着） | 前端 `ProtectedImage`（`contextmenu` + `dragstart` 双拦、`draggable=false`、透明盾、`user-select`/`-webkit-user-drag`/`-webkit-touch-callout: none`）覆盖试看浮层与详情页图集，视频/音频一并拦；服务端试看**独立限流**（60/分钟，与下载分开计数）+ `no-store`/`nosniff`。**代码与文档都写明「这不是安全边界」**，真要防得服务端给降采样 + 水印的派生图（ERRORLOG §17.4） |
| 76 | 清理「无引用文件」时**差点删掉使用者正在上传的附件** | 传完但还没点发送的附件，在库里就是「无引用」，而清理工具只看引用面。实测撞到：一个 127KB 的 webp 刚进 `uploads/files`，正好落在一次清理的窗口里 | `cleanup_orphan_files.mjs` 加**熔断**：默认跳过最近 60 分钟内改动过的文件（`--min-age-minutes=N` 可调，`0` 关闭），删除前仍会复查引用。**教训：判定「垃圾」不能只看数据库引用，还要看时间** —— 使用者可能正在用这个应用 |
| 77 | 「商城首页卡片里的图也能右键下载」 | `ProductCard` 还是裸 `<img src={coverUrl}>`（我只在试看链路上做了防护）。另外：**封面放在 `uploads/covers/`，该目录在 `static.expose` 里 —— 连登录都不用就能直接取**，所以「拦住右键」并不等于「保护了封面」 | 卡片封面改走 `ProtectedImage`（右键/拖拽/长按全拦、盾完整覆盖封面区、**不影响整卡点击**）。同时在文档里点明：要真正保护封面得把它从静态暴露里摘掉、改走鉴权接口 + Blob（牵动 `files.types` 自定义封面，未做，见 ERRORLOG §17.4） |
| 78 | 「同时禁用 F12」这类需求怎么做才不坑自己 | 浏览器快捷键**没法真正禁用**（菜单里照样能开开发者工具），而且一刀切会误伤：聊天输入框的右键粘贴、消息文本的右键复制都是正常需求 | 新增 `utils/captureGuards.js`：捕获阶段拦 F12 / Ctrl(⌘)+Shift+I·J·C / Ctrl+U / Ctrl+S，**只在生产构建安装**（`import.meta.env.DEV` 下不装，开发时照样能按 F12），并留 `?dev=1` 逃生口。回归里正反两侧都断言：F12/Ctrl+Shift+I/Ctrl+U/Ctrl+S 被拦，单独按 `u`/`s`、Ctrl+C/V/A、Enter、F5 **一律不拦**。**不做**「检测到开发者工具就清空页面」那种反调试（误报误伤、一样能绕） |
| 79 | 用户追问「**为什么不直接在网站里禁用所有右键**，除了自定义的菜单外」 | 我原先只拦图片，理由是怕误伤。真要全禁，两个坑必须避开：① 应用自己的右键菜单（聊天 `ContextMenu`）挂在 React 的 `onContextMenu` 上、**靠冒泡触发** —— 顺手 `stopPropagation` 就会把自定义菜单一起干掉，恰好和需求相反；② 输入框/可编辑区域一禁，右键粘贴与拼写检查全没，**手机端长按粘贴是唯一粘贴方式**（没有 Ctrl+V） | `installContextMenuGuard()`：捕获阶段**只 `preventDefault`、绝不 `stopPropagation`**；`MENU_EXEMPT_SELECTOR` 默认豁免 `input / textarea / [contenteditable]`（置空即「连输入框也拦」，已有用例）；与键盘守卫同一套策略（生产才装、`?dev=1` 跳过）。回归断言「自定义菜单照常弹出 + 输入框保留菜单 + 普通区域与图片被拦」。**连带效果（已写进文档）**：手机端长按保存聊天照片也失效，想保留就把 `.msg-image` 加进豁免选择器 |
| 80 | 右键表情消息的「购买表情包」原来跳商城的「表情包」分类，用户还得自己找 | 前端有一份 `stickerBuyProductId` 状态与对应的 `ProductDetailModal` 渲染分支，但 `setStickerBuyProductId` 从未被赋过非空值（死代码）；实际走的是 `openView('shop', {...})` | **B1 修复**：`openBuy` 改为先调 `/api/stickers/lookup?url=` 反查该表情包的 `productId`（只有 `source='purchase'` 的表情包才有），能查到就 `setStickerBuyProductId(pid)` 直开商品详情，反查不到（用户自建的表情包）就明确提示。为此 `client/src/api/stickersApi.js` 新增 `lookupSticker()` |
| 81 | `buildMenuItems` 的 `useCallback` 依赖数组漏 `openView`（以及新用到的 `token`） | 原实现只列 `[socket, myStickerPacks]`；只因 `openView` 是空依赖的稳定引用才没真出 bug | **C1 修复**：依赖数组补 `token` 与 `openView` |
| 82 | `ShopPage` 的 `me` prop 是死 prop（组件内部从不使用，传给 `ProductDetailModal` 也无人接收） | 遗留 | **B2 修复**：`ShopPage` 与 `ChatRoom` 两侧都删掉 `me` |
| 83 | `MessageBubble` 里给 `<FileTypeIcon>` 传 `mime={message.mime}`，但 `message.mime` 恒为 `undefined` | 后端 `loadHistory()` 从不下发 `mime` 字段（给的是 `fileType`）；`fileKind()` 本来就按扩展名判，所以前端行为一直是对的，只是这个 prop 白传 | **C2 修复**：删掉这两处 `mime` prop（`msg-audio` 分支与 `msg-file` 分支） |
| 84 | `AdminRoleRequestsTab` 的 `prompt(...) ?? null` 多余 | `prompt` 本来就在「取消」时返回 `null`、其他情况返回字符串；`?? null` 不改变结果 | **C3 修复**：删掉 `?? null` |
| 85 | `PluginHost` 在 React StrictMode 下自伤：开发时插件加载会时好时坏 | `useEffect` 的 cleanup 里**立即**发 `DELETE /ticket` 撤销本用户在该插件下的全部票据。StrictMode 下 effect 会跑「挂载 → 卸载 → 挂载」，第一次 cleanup 就把票据撤销了，第二次挂载拿不到有效票据。生产构建没有 StrictMode，用户不受影响 | **C4 修复**：cleanup 里**延迟 300ms** 再撤销，第二次挂载时 `clearTimeout` 取消它。真正离开（超过 300ms 没回来）才发撤销请求。票据本身 60 秒过期，这个「加速失效」只是尽力而为，不是安全边界 |
| 86 | `ProductDetailModal.selectMedia` 里 `catch` 刚写完错误消息，同函数的 `finally` 立刻把它清空 | 视频加载失败时用户看到的是**空白**，而不是失败原因 | **A1 修复**：把清空 `mediaNote` 从 `finally` 挪到 `try` 成功路径末尾 |
| 87 | 一条**没带文字**的视频/音频消息，在会话列表 / 导航浮层里的摘要**显示为空** | `utils/room.js::roomPreview()` 只判了 `image` / `file` 两种 `fileType`；§1.60 之后是四种 | **A2 修复**：补 `video → '[视频]'`、`audio → '[音频]'` |
| 88 | `ApiKeysModal` 申请密钥请求在飞时，点 ✕ / 遮罩 / Esc 都能关掉弹窗 | 服务端**已经生成了一把可用密钥**，但弹窗卸载后 `setOnce(d)` 永远没机会跑，用户永远看不到明文 —— 与 UI 里「明文密钥只显示这一次」的承诺直接矛盾（ERRORLOG §8.3 CLI-2） | **A3 修复**：三处（遮罩 / ✕ / Esc）都加 `!creating` 拦截 |
| 89 | `server/package.json` 里 `@aiwayds/dsh-model-sync` 是死依赖 | 全项目 `grep` 不到任何 `require` / `import`；且它给项目引入了一个不必要的隐性约束 `engines.node >= 22.19.0`（项目自己是 `>= 22.5.0`），还拖着 6 个 `@deepseek-ai/*` peerDependencies | **C6 修复**：从 `package.json` 删掉；`server/` 跑一次 `npm install` 同步 lock |
| 90 | **聊天到底部时最后一条气泡显示不全 / 继续向下诡异抖动** | 三因叠加：① Virtuoso 计算 item 高度用 `offsetHeight`，**`margin` 不计入**——`.message` / `.date-separator` 的间距全用 `margin` 撑，导致它算的高度比实际视觉少 16px，永远比实际早一点判「到底」；② `.chat-area` / `.messages-wrap` 缺 `min-height: 0`，flex 子项默认 `min-height: auto`，Virtuoso 拿到的可用高度在边界场景下会算错，最后一段被 `overflow: hidden` 裁掉；③ `atBottomThreshold={120}` 太大（距底 120px 就算到底）+ `followOutput: 'smooth'`（动画滚动天生易被打断）→「滚 → 被打断 → 再滚」的拉锯 = 抖动 | `.message` / `.date-separator` 的 `margin` → `padding`（含两处响应式）；`.chat-area` / `.messages-wrap` 补 `min-height: 0`；`atBottomThreshold` 120 → 40；`followOutput` 由常量 `'smooth'` 改为函数 `(isAtBottom) => isAtBottom ? 'auto' : false`；加 `increaseViewportBy: { top: 400, bottom: 400 }` 和 `computeItemKey` |
| 91 | **认证从「JWT + localStorage」改为「Cookie + 刷新令牌」** | 原方案两个结构性缺陷：① 7 天 JWT 存 localStorage，XSS 一次即可长期窃取；② 无状态 = 无法撤销，改密码 / 封号 / 怀疑泄露时踢不掉已签发的 token。而「能不能撤销」对长期凭据是硬需求，JWT 无状态在这件事上恰好是缺点 | **双 token**：Access（JWT 15m，前端**内存**持有）+ Refresh（随机串 30d，**HttpOnly Cookie** 持有，`Path=/api/auth`，`SameSite=Strict`，`Secure` 按环境自动）。Refresh 落库（只存 SHA-256，`refresh_tokens` 表），每次刷新**轮换**；收到已撤销的 Refresh = 重放信号 → **撤销整个 family** 并强制重新登录。前端 `auth/session.js` 是唯一持有者（模块内存），`api/http.js` 收到 401 TOKEN_EXPIRED 时自动 `refresh()` + **重放一次**（`_retried` 标记防无限循环）；并发 401 用单一 in-flight Promise 去重。socket 握手时 `auth.token` 传 Access（Access 不在 Cookie 里）；`connect_error` 识别认证类错误后先刷新再重连。API 密钥通道（`X-API-Key`）独立不变 |
## 2 规则清单（照做）
- **Virtuoso item 的间距必须用 `padding` 而不是 `margin`**（§1.90）：Virtuoso 用 `offsetHeight` 计算 item 高度，`margin` 不计入。任何「item 与 item 之间」「item 上下」的间距如果是 margin 撑的，就会让它的「到底」判定比视觉真实提前。已在 `.message` / `.date-separator` 上踩过，改 margin → padding。新加虚拟列表 item 时照做。
- **flex 容器里凡是「父容器有明确高度、子容器要滚动」的层，必须显式 `min-height: 0`**（§1.90）：flex 子项默认 `min-height: auto`，会撑到内容高度而不是父容器可用高度。`.chat-area` / `.messages-wrap` 就是典型，缺这个在长内容 / 高 item 场景下最后一段会被 `overflow: hidden` 裁掉。凡是「`flex: 1` + `overflow: hidden/auto`」的组合都要补。
- **虚拟列表的滚动参数：`atBottomThreshold` 不要超过 item 的典型高度；`followOutput` 优先用函数式而非常量 `'smooth'`**（§1.90）：`'smooth'` 是动画滚动，任何高度重算都会打断它并重触发，和用户手动滚动形成拉锯。正解是 `(isAtBottom) => isAtBottom ? 'auto' : false`——只在**确实在底部**时跟随，且用瞬时贴底。阈值太大（120px）会让用户在视觉上还没到底时就被判定「在底部」，是抖动的放大器。
- 改动前先读 §0；新增组件前先确认没有同类（历史上 `ChatSidebar`→`ListPanel`+`SideNav`、`TopNav` 被推翻删除）。
- 类名体系只有一套：`.sidenav*`（导航）、`.nav-item/.nav-row/.nav-title/.nav-sep/.nav-badge`（行）、`.panel*`（列表）、`.view`（整页）。**不要再引入第二套**（如 `topnav/menu-*`）。
- **CSS 不要用 `.x > span` 这类泛化标签选择器去命中「文字标签」**：`Avatar` 的根节点就是 `<span>`（`.dot` 也是），会被一起命中；而且 `flex` 简写会把 `flex-basis` 变成 `0%`，**flex-basis 非 `auto` 时会压过内联 `width`**，把头像拉宽（§1.33）。要命中就带类名（`.nav-main`），或显式 `:not(.avatar):not(.dot)`。
- **请求头不能当身份 / 配额键**（§1.36）：`X-Forwarded-For`、`X-Real-IP`、`Referer` 全是客户端可伪造的。IP 绑定、失败次数、审计日志一律走 `utils/ip.js::clientIp()`（默认 `req.ip`），只有部署在反代后才开 `security.trust_proxy`。**开了也要取对方向**：反代把真实对端**追加在 XFF 末尾**，取第一段等于采信伪造值（§1.47）。
- **任何「绑定 / 配额」都必须真正在读取时校验**（§1.46）：写入时记一个 `boundIp` 只是记账，不是控制 —— 密钥、房间、IP 都一样，**校验点必须在每次使用的那条路径上**，且要有行为级用例（`security_check.mjs`）。
- **监听地址必须显式配置，缺省即回环**（§1.44/45）：dev server 与后端都一样。要对外暴露就显式写 `VITE_DEV_HOST` / `server.host` + 反代；**永远不要在代码或配置兜底里写成 `0.0.0.0`**。
- **要给别人／手机访问就走后端单端口，不要开 dev server**（§1.52）：`cd client && npm run build` → `cd server && npm run start:lan` → `http://<本机IP>:3001`。dev 模式**必然**把源码发给访问者，没有开关能关（浏览器要的就是源文件）；`dev:lan` 只留给「可信网络 + 确实需要 HMR」。
- **动 `app.js` 的静态托管段要跑 `test:static`**（§1.53）：前端静态与 SPA fallback 必须挂在 `/api` 路由与 `/api` 404 **之后**，并显式排除 `api|uploads|socket.io|health`；顺序错了不会报错，只会让接口返回 HTML。
- **`job_kill` 之后必须确认端口真的空了**（§1.54）：它只杀 pwsh 包装，node 子进程会继续占端口；按 PID 查 CommandLine 再 `Stop-Process`。
- **图片上传一律走 `utils/image.js` 的 `prepareImage()`**（§1.55）：不要在各组件里自己 `fd.append('avatar', file)` —— 那会绕过「按 EXIF 方向解码 + 压缩 + HEIC 转码」。接入点在 **API 层**（`uploadAvatar` / `uploadAssets` / `uploadStickerItems` / `uploadShopCover` / `uploadFile`），组件只需调 API。
- **图片格式白名单只有一处真相**（§1.57）：`config.yaml` 的 `uploads.avatar.allowed_ext` 与 `business.assets.allowed_ext/allowed_mime`（+ `services/assets.js` 的 `MIME_EXT` 映射）。**拒绝文案是现算的，别改回硬编码**；改完跑 `npm run test:formats`。
- **HEIC/HEIF/TIFF 服务端不收是有意的**（§1.56）：桌面浏览器渲染不了，收下来是裂图。手机端的 HEIC 由客户端转 JPEG，不要为了「支持 HEIC」去放宽白名单。
- **展示图压缩、交付物不压缩**（§1.55）：头像 / 背景 / 气泡 / 表情 / 商品封面都压缩；`/api/shop/upload` 的商品内容文件是交付物，**一律原样上传**。
- **不要相信「某处有魔数校验」**（§1.59）：服务端目前**没有**文件魔数校验，只按扩展名 + MIME 判。涉及上传安全的设计别建立在这个错误前提上。
- **附件按类型分流渲染**（§1.60）：`/api/file` 返回 `kind`（`image/video/audio/file`），`MessageBubble` 据此选播放器或卡片。**媒体播不了必须退回卡片并给提示**，不要静默留一个坏掉的播放器；视频一律 `preload="metadata"` + 不加 `autoplay`（群聊里多个视频会一起加载）。
- **文件类型图标只有一个来源**（§1.60）：`components/common/FileTypeIcon.jsx`（组件 + `fileKind()`）。不要再写第二套字母方块；新类型往 `EXT_GROUPS` 里加即可（品牌色沿用既有取色）。
- **「试看」与「下载」是两条不同的权限**（§1.60）：`/api/shop/preview` 登录即可、只放行 `is_preview=1`；`/api/shop/download` 仍需购买并写审计。前端未购买时**只隐藏下载，不隐藏预览**。
- **商品图集复用 `product_files.is_preview`**（§1.60）：封面 + 勾了预览的图片/视频即图集，**不需要新表/新字段**。图片走鉴权 Blob，**视频点中才加载**（否则一进详情页就下整段视频）。
- **浏览器里跑 UI 回归的两条硬规则**（§1.61）：① JSX 不能写在 HTML 内联 `<script type="module">` 里（Vite 会当纯 JS 解析并 500），拆成 `.jsx`；② 页面与结果回收口**必须同源**（Chromium 会拦跨源访问回环地址），用同源反代包住 Vite。
- **文件类型的唯一真相是 `utils/fileTypes.js`**（§1.64）：内置 11 类在里面，开发者新增/覆盖的类型由 `config.yaml → files.types` 经 `GET /api/file-types` 下发，**自定义优先**。新类型不要再往组件里硬编码；`FileTypeIcon.jsx` 只负责画。
- **改配置类的东西要「警告并跳过」而不是「崩」**（§1.64）：`files.types` 里一条写错不该让整个后端起不来 —— 校验失败的条目打明确警告后跳过（对照 §1.25：**缺关键项**才该直接抛错，**多写了坏条目**不该）。
- **异步拉回来的注册表要用 `useSyncExternalStore` 订阅**（§1.65）：纯函数组件不会因为模块级变量变化而重渲染，否则「拉到了但屏幕上的旧图标不更新」。
- **`<img>` 要同时给 `width/height` 属性与样式**（§1.67）：只给样式会导致图片加载完抖动一下。
- **音视频转码「只产副本、永不改原件」**（§1.68）：原件是下载 / 商品交付的交付物，必须逐字节不变；转码只服务「在线播放」。副本地址由源文件名**确定性推导**（`uploads/<子目录>/tc/<同名>.mp4|.mp3`）—— **不改库、不改协议**，历史消息与所有客户端都靠 `GET /api/media/status` 问出该播哪个地址。
- **判「浏览器能不能播」必须看容器 + 编码，不看扩展名**（§1.69）：判定输入必须来自 `ffprobe`。改白名单时把「HEVC 装 mp4」「h264 装 mkv」这两个反例一起想一遍。
- **ffmpeg 写临时输出要显式 `-f`**（§1.68）：ffmpeg 按输出扩展名猜封装，写 `*.part` 不加 `-f` 会直接失败。先 `.part` 后 `rename` 是「静态目录永不出现半截 mp4」的唯一办法，别为了省参数改回去。
- **媒体播不了先问服务端，再决定要不要退卡片**（§1.70）：`MessageBubble` 的 `onError` 先去 `/api/media/status`（服务端可能已转好或正在转），只有服务端也救不了才退回卡片。新增播放器 / 媒体类型时沿用这条，不要直接回退。
- **缺 ffmpeg 必须降级、不能报错**（§1.68）：没装只打一条警告，上传链路照常、播不了退回卡片（旧行为）；转码相关配置全部有代码兜底默认值。
- **请求路径上禁止 `spawnSync`**（§1.72）：它会按住整个事件循环（所有请求 + socket 心跳），而外部进程的耗时是不可控的。要用 `spawn` + Promise（必要时加超时 kill）；只有启动期一次性的版本探测可以同步跑。
- **删文件的脚本，引用面必须动态穷举**（§1.73）：`/uploads/` 路径不只在「显然的 URL 字段」里 —— `room_settings.icon`、`user_preferences.background`、`bubble` 主题 JSON、`groups.avatar`、`messages.sender_avatar` 都可能有。一律遍历 `sqlite_master` 里的所有表、把每行 JSON 里的路径抠出来，且**删除前复查引用**（仍被引用就保留）。别手列字段，也别写一次性的临时脚本。
- **跑完自检套件必须收尾，且已自动化**（§1.74）：`test:api` / `test:socket` / `test:room-icon` 打在真实库上，三者现在**跑完自动收尾**（`scripts/lib/cleanup_accounts.mjs`：删本套账号 + 清本次新产生且无人引用的上传文件）；要留现场加 `--keep`，它会打印事后手动清理的命令。手动兜底仍是两步：`npm run cleanup:test-data -- --prefix sm_,sk_,ric_ --apply`（账号 + 名下数据）与 `npm run cleanup:orphans -- --apply`（全局孤儿文件）。两个清理脚本默认都是**演练**，确认列表再加 `--apply`。
- **清理工具必须对「正在被使用」留余地**（§1.76）：`cleanup_orphan_files.mjs` 默认跳过最近 60 分钟内改动过的文件 —— 「库里没人引用」不等于「是垃圾」（传完还没发送的附件就长这样）。跑清理前先看一眼演练输出。
- **试看 / 下载是受保护内容的两个出口，任何新出口都要限流**（§1.75）：客户端拦右键只是提高顺手拿走的成本，**不是安全边界**（开发者工具、脚本、截图都拦不住）。要真正控制「能拿走什么」，只能在服务端决定给什么内容（降采样 + 水印的派生图）以及给多少（限流）。
- **「静态公开目录」里的文件谈不上保护**（§1.77）：`static.expose` 里的 `avatars / files / covers / custom` 谁都能直接取（`/uploads/covers/x.png` 连登录都不要）。**拦住右键 ≠ 保护了内容** —— 要保护就得把它从 `static.expose` 摘掉、改走鉴权接口 + Blob 渲染（客户端不能用 `<img src>` 直连，因为 `<img>` 带不了 Authorization 头）。
- **「禁用 F12」只能做「防误触」级别**（§1.78）：快捷键拦得住，浏览器菜单拦不住，反调试手段一律不做（误伤 + 一样能绕）。守卫**只在生产构建装**，开发与 `?dev=1` 跳过。
- **「全站禁用右键」的两个必留口子**（§1.79）：① **只 `preventDefault`，绝不 `stopPropagation`** —— 应用自己的右键菜单靠 React 冒泡触发，拦了冒泡等于把自定义菜单一起禁掉（与需求相反）；② **输入框 / 可编辑区域必须豁免** —— 右键粘贴与手机长按粘贴是刚需。要更狠就把 `MENU_EXEMPT_SELECTOR` 置空；要让聊天图片继续可长按保存，就把 `.msg-image` 加进豁免选择器。
- **显示层的类型表 ≠ 上传白名单**（§14.4）：`files.types` 只管图标/封面；某个扩展名能不能**上传**仍由 `uploads.*.allowed_ext` 决定，别把两者混起来悄悄放宽上传面。
- **给「后面才建的表」补列，`addCol` 必须放在建表之后**（§1.50）：`schema.js` 分两段建表，补列区在第一段后面；放错位置只有**全新库**才会暴露（老库表已存在），本地永远测不出来 —— 所以新加的迁移一定要用**临时空库**起一次实例。
- **对外可见的用户字段遵循最小化**（§1.49）：在线列表只给 `id/nickname/avatar`，**不给 `username`**（登录标识 = 爆破原料）；能用「关系」限定的列表就不要全站返回。
- **每个接口都要做「对象级授权」**（§1.37/38/39）：服务端权限校验不能只停在「你是谁」，还要答「你和这个对象是什么关系」。历史漏的三处都在**读操作与副作用操作**上：`getGroupInfo`（读成员名单）、`markRead`（写已读）、`emitTyping`（发通知）。
- **测试脚本不得改动真实数据**（§1.42）：新增/修改自检脚本时，破坏性操作必须**收窄到本套测试账号**（按创建时拿到的 id，不要按模糊前缀），改动共享状态（`room_settings`、系统设置等）前先**快照**、收尾**还原原值**；提权后必须还原角色，申请的密钥必须撤销。
- **任何「整页模式」下的 emoji/图标选择网格都必须自己限宽**（`.avatar-editor` / `.room-icon-editor`，`max-width:520px`）：`.view > .modal-overlay > .modal-card` 是 `width:100%!important`（§1.34），不限宽就会被拉成超大按钮。
- 前端文案里的「支持格式 / 大小」必须与服务端上传白名单一致（§1.35）：头像 = PNG/JPG/GIF/WebP、≤5MB、**不支持 SVG**。
- UI 图标只用 `Icon.jsx` 的 SVG，禁用 emoji 当图标（头像里的 emoji 是用户数据，保留）。
- 权限相关 UI 一律由 `can()` 派生，禁止硬编码页签/入口。
- 整页模式下弹窗的 `onClose` ≡ `backToChat`；子组件保持 `onClose/onChanged/onSaved` props 形状。
- 会话列表行的消息摘要用 `utils/room.js` 的 `roomPreview()`，不要各写一份。
- 房间图标统一走 `components/common/RoomIconEditor.jsx`（emoji 预设 + 上传，复用 `.avatar-grid/.avatar-choice`），别写第二套。个人信息页的 `AvatarEditor` 复用同一套类名与 `AVATAR_PRESETS`，两边观感应保持一致。
- 图标权限：公共聊天 = 能力位 `manage_public_room`（`can()` 派生，仅开发者）；群 = 群主 / 群管理员（`group_members.role`），**群名仍只有群主可改**。前端只是入口，服务端 `services/rooms.js` 与 `services/chat.js` 会再校验一次。
- 会话行的房间图标一律用 `<Avatar name avatar>`（图片 / emoji / 首字母三态通吃），不要再 `name.slice(0,1)` 手搓 `.group-avatar`。
- **头像形状只有一种：方形圆角**（`Avatar.jsx` 里 `borderRadius: size * 0.3`，也等于 `.sidenav-logo`（11/34≈32%）与 `.avatar-choice`（8px）的观感）。任何新头像都别写 `border-radius: 50%`，页面里保留圆形的只有状态点 `.dot` / 打字小点 / lightbox 关闭键这类非头像元素。
- **聊天列表常驻**：ListPanel 不再有折叠态（`.panel-toggle` / `.panel-restore` 与 `ui_list_collapsed` 标记已删除，旧 localStorage 值会被无视）。不要再加回折叠入口。
- **右键表情消息的「购买表情包」必须直开商品详情**（§1.80）：`ChatRoom` 的 `openBuy` 先调 `/api/stickers/lookup?url=` 反查 `productId`，能查到就 `setStickerBuyProductId(pid)` 弹出 `ProductDetailModal`，反查不到就明确提示「不是从商城购买的」。**不要**再回到「跳到商城分类让用户自己找」的旧实现。
- **`useCallback` 的依赖数组必须列全**（§1.81）：只要回调体内用到了外部变量（即便它当前是稳定引用），就把它列进依赖数组。`buildMenuItems` 之前漏了 `openView`，靠它恰好是空依赖的稳定引用才没暴雷 —— 这不是可以不列的借口。
- **props 只传组件真正会用的**（§1.82 / §1.83）：`ShopPage` 的 `me`、`MessageBubble` 给 `FileTypeIcon` 传的 `mime` 都属于「传了但没人用/恒 undefined」。改动时顺手删，别留半截。
- **React StrictMode 会「挂载 → 卸载 → 挂载」**（§1.85）：任何「在 useEffect 的 cleanup 里做不可逆操作」（清票据、注销资源、写库）的代码都要考虑这一点 —— 要么延迟执行 + 二次挂载时取消，要么把不可逆操作挪出 cleanup。
- **请求在飞时要挡住弹窗关闭**（§1.88）：`ApiKeysModal` 的申请密钥请求在飞时（`creating`），遮罩 / ✕ / Esc 三处都要拦截。否则服务端已经下发的**一次性**明文会被弹窗卸载丢掉，永远拿不回来。类似「一次性凭据」的交互都要遵守这条。
- **`finally` 里不要清「只在失败路径才需要保留」的状态**（§1.86）：`catch` 里 `setMediaNote(err.message)` 之后再 `finally { setMediaNote('') }` 等于把错误提示吞掉。`finally` 只该做「无论如何都要做」的清理（如关 loading），不该覆盖 catch 刚写入的内容。
- **会话摘要要覆盖全部 4 种附件类型**（§1.87）：`roomPreview()` 必须处理 `image` / `video` / `audio` / `file`，否则无文字的视频/音频消息在列表里显示为空。
- **`package.json` 里的每个 `test:*` 都必须指向真实存在的脚本文件，且都要在 §0 / §3 登记**：`sticker_pack_check.mjs` / `plugin_check.mjs` **确实存在**（本轮已核实）—— `test:stickers` / `test:plugins` 两个注册**有效**，只是此前从未在 §0 / §3 登记过，等于对后来者是隐形的。**新增/删除任何 `test:*` script 时同步 §0 / §3**，登记内容至少含：脚本路径、项数、是否自包含（是否隔离实例 / 临时库）、是否跑完自动收尾。

## 3 验证方法（当前模型无图像输入，别截图）

- 无头 Edge + CDP 做**几何/样式断言**：`getBoundingClientRect`、`getComputedStyle`、元素计数、`documentElement.scrollWidth`（横向溢出）、`position`（浮层/内嵌）。
- **只测 CSS 布局时不必起整个应用**：写一个静态 harness（`<link rel="stylesheet" href="file:///.../styles/index.css">` + 复现目标 DOM 结构 + 脚本把测量结果写进 `<pre>`），再用 `msedge --headless --dump-dom` 取回，配合**对照组**（故意保留修复前的结构）证明差异 —— 详见 §1.33/34 的实测数据。
- **`msedge.exe` 是 GUI 子系统程序，PowerShell 的 `&` 抓不到它的 stdout**（会得到 0 行）。必须 `Start-Process -RedirectStandardOutput <file> -Wait` 再读文件。
- 交互用真事件：`Input.dispatchMouseEvent`(moved/pressed/released)、`Input.dispatchKeyEvent`(Escape)、`Emulation.setDeviceMetricsOverride`、`Emulation.setTouchEmulationEnabled`，reload 后断言。
- 每轮收尾必做：删临时脚本、删测试数据（`uicheck%` 用户 + `points_transactions/user_points/user_preferences/api_keys`）、kill 自起进程、删 `%TEMP%\edge-uicheck-profile*`。
- 起服务：`cd server && npm start`（默认只监听 `127.0.0.1:3001`）；**局域网共享走后端单端口**（§1.52）：
  - `cd client && npm run build` → `cd server && npm run start:lan` → 手机开 `http://<本机IP>:3001`（单端口同时提供页面 / API / 上传 / socket.io，无代理无 CORS，只发构建产物）
  - `npm run dev`（client）→ dev server 绑 `127.0.0.1`，本机开发 + 热更新
  - `npm run dev:lan`（client）→ dev server 绑 `0.0.0.0`，**会把完整源码发给同网段任何人**，仅限可信网络
  - 命令行可临时改监听地址：`node index.js --host 0.0.0.0 --port 3001`（跨平台；PowerShell 不支持 `HOST=x npm start`）
- 现成回归脚本（都需先起服务）：`cd server && node scripts/smoke_test.mjs`（139 项）、`node scripts/room_icon_check.mjs`（41 项，房间图标权限）、`cd client && node ../server/scripts/socket_check.mjs`（46 项，含房间图标实时广播 + §5.5 socket 崩溃回归）。三个脚本都会**只清理自己创建的测试账号**，并在改动 `room_settings` 前先快照、收尾还原原值。
- **`cd server && node scripts/security_check.mjs`（29 项，安全控制回归）**：验证监听地址默认值、密钥 IP 绑定、XFF 可信性、登录限流、在线列表可见范围。它**自包含**——自己在系统临时目录生成隔离配置 + 独立数据库，自己拉起独立端口的实例，跑完杀掉并删干净，因此**不需要先起服务**，也绝不碰 `chat.db`。要验证「全新库能否启动」也用它（每个实例都是空库）。
- **`node scripts/cleanup_test_data.mjs (--ids 1,2 | --prefix sm_) [--apply]`**：按明确 id / 用户名前缀彻底清除测试账号（数据库关联行 + `uploads/` 内文件）。**默认只演练**，永远拒绝 id ≤ 3。自检脚本跑完若仍留下账号，用这个收尾（§1.51）。删文件前会**再查一遍全库引用**，仍被引用的（如公共聊天图标指向某账号头像）一律保留（§1.73）。
- **`node scripts/cleanup_orphan_files.mjs [--apply]`（= `npm run cleanup:orphans`）**：清掉 `uploads/` 里**没有任何库内引用**的文件 —— 没挂到消息上的测试上传、`uploads/tmp/*` 里中途放弃的临时图、已删账号的旧头像等，`cleanup_test_data.mjs` 看不到这些。引用面是**动态穷举**的（遍历所有表 + 每行 JSON 抠路径），默认只演练。三套打真实库的自检**已自带收尾**（§1.74），这个是手动兜底 / 清理历史残留用的。
- **`cd server && node scripts/image_check.mjs`（15 项，前端图片规范化）**：用**无头 Edge** 跑真实的 `client/src/utils/image.js`（canvas / EXIF / toBlob 在 Node 里跑不了）。脚本自己起本地静态服务把 harness 与源码喂给浏览器，页面把断言 POST 回来。改动 `utils/image.js` 或压缩参数后必跑。
- **`cd server && node scripts/upload_format_check.mjs`（25 项，上传格式白名单）**：自包含（临时配置 + 临时空库 + **临时上传目录**），断言「哪些格式该收、哪些必须拒、拒绝时文案说什么」。改 `config.yaml` 的上传白名单后必跑。
- **`cd server && node scripts/file_types_check.mjs`（15 项，文件类型表）**：自包含，断言 `files.types` 的规范化、非法条目只警告不崩、`GET /api/file-types` 需登录、只下发合法项。改 `files.types` 或该接口后必跑。
- **`cd server && node scripts/transcode_check.mjs`（137 项，音视频转码）**：自包含（临时配置 + 临时空库 + 临时上传目录 + 隔离端口），用**本机 ffmpeg 现场生成**素材（mp4 / webm / mp3 / flac / mkv / avi / wma / HEVC-in-mp4 / 文本冒充 mp4），断言「该不该转、副本编码对不对、原件有没有被动过、副本能不能拖进度条、重复查询会不会重复转、历史附件能否自愈、商城试看与下载的差别」，外加路径穿越 / 未登录 / 非 files 目录等边界。改 `services/transcode.js`、`media.transcode` 配置或媒体白名单后必跑（**需要 ffmpeg**，这正是被测对象）。
- **`cd server && node scripts/sticker_pack_check.mjs`（= `npm run test:stickers`，项数待补测）**：表情包系统回归。脚本确实存在（2026-09-27 创建）；具体项数、是否自包含（隔离实例 / 临时库 / 临时上传目录）、是否跑完自动收尾，**本轮未实测**，留待补测后更新本节。
- **`cd server && node scripts/plugin_check.mjs`（= `npm run test:plugins`，项数待补测）**：插件系统回归。脚本确实存在（2026-09-28 创建）；具体项数、是否自包含、是否跑完自动收尾，**本轮未实测**，留待补测后更新本节。
- **前端「注册表合并 + 封面渲染」怎么验**：用临时 harness 在无头 Edge 里跑真实组件（`applyCustomTypes()` 后断言 DOM 从 SVG 变成 `<img>` 封面、`loadFileTypes()` 真打接口且只打一次）。UI 校验历史上都是临时脚本，跑完删（§1.61 的两条硬规则照办）。
- **浏览器 harness 的取结果方式**：不要指望 `msedge --dump-dom` 能等到异步断言跑完 —— 页面**主动 POST 结果**回来更可靠（§1.46 的写法，见 `image_check.mjs`）。
- 想验证「修复是否生效」而不想污染真实库时：用 `PORT=3002 node index.js` 另起一个实例，再给脚本加 `SMOKE_BASE` / `SOCKET_BASE` 指向它。
- 无头 Edge 自检脚本在 client 目录跑（`ws` 从 client/node_modules 解析），结束时删脚本、删 profile、删测试账号（`ui_/ric_/sm_/sk_` 前缀 + 对应消息/群/积分/密钥）、还原 `developer` 角色与 `room_settings`。
- **`server/scripts/` 里的每个 `.mjs` 都对应 `package.json` 的一个 `test:*`（反之亦然）**：本轮删掉了 `test:stickers` / `test:plugins` 两个指向**不存在文件**的无效注册（§1.89）。新增 `test:*` 前先确认脚本文件存在；新增脚本后同步补 `package.json`。

## 4 时间线（每段一句，了解演进即可）

1. 左侧竖条按钮 → 可折叠图标条（后被推翻）。
2. emoji→SVG、合并类名、按钮放大、导航改白底。
3. 去弹窗：功能全部转整页；顶部洛谷式悬停下拉（后被推翻）。
4. 改为**左侧统一导航**：细条 + 悬停展开 + 子功能浮层（现行）。
5. 修：管理入口不响应（页签硬编码 + key 不重建）、账户无头像、浮窗向下越界。
6. 管理员 `manage_apikeys` 90→50；查清「socket.io 连不上」＝后端未运行，或 dev server 被 §1.9 的 EBUSY 杀掉。
7. **房间图标**：站点图标 / 导航栏品牌图标统一用 `client/public/logo.jpg`；公共聊天图标独立存 `room_settings`（能力位 `manage_public_room`＝仅开发者）；群图标走 `groups.avatar`，群主 + 群管理员可改，群管理员由群主任免（`group_members.role='admin'`），并新增 `room:public:*`、`group:update`、`group:member:role` 的 socket + REST 双通道。
8. **列表与头像观感**：聊天列表去掉折叠（常驻 300px）；全站头像由圆形改为方形圆角（`Avatar.jsx` 一处改动即覆盖会话行 / 群图标 / 成员列表 / 消息气泡 / 编辑器预览）。
9. **全量审计与加固**：修上传路径前缀逃逸、商品文件 URL 未校验、买家下载按钮失效、免费商品无法定价、限流内存膨胀、`/api` 无 JSON 兜底、官方账户锁定哈希、lint 全红、商城搜索抖动；清理 2 处未使用变量与 `usePreferences` 死状态。见 §5。
10. **修复致命崩溃**：`socket/index.js` 从 registry 解构了未导出的 `onlineUsers`（拿到 `undefined`），**改昵称 / 头像触发的 `user:refresh` 100% 打崩后端**；顺带发现 25 个 handler 大多无入参默认值，任一畸形包都能打崩服务。已改用 `getOnlineUsers()`、给每个 handler 包 try/catch、全部补 `= {}`，并把该场景固化进 `socket_check.mjs` §5.5。
11. **修头像 / 图标布局**：「最近会话」浮层里群图标被撑满整行（泛化选择器 `.nav-row > span` 命中了 `Avatar` 的根 `<span>`，`flex-basis:0%` 压过内联 `width`）；个人信息页 emoji 网格摊满整屏（缺限宽容器，而整页模式下 modal-card 是 `width:100%!important`）。已收窄选择器 + 新增 `.avatar-editor` 与 `.room-icon-editor` 共用样式，并把「支持 SVG」的错文案改成与服务端白名单一致。
12. **第三轮全项目深挖**：修 `X-Forwarded-For` 无条件信任（一击废掉 IP 绑定 + 暴力枚举防护）、`getGroupInfo` 越权拉成员名单、`markRead` 伪造已读、`typing` 跨会话注入、封面地址零校验；并把「仓库里写死特权账号密码」「自检脚本删真实数据」这两处工具链事故一并修掉。优化项见 `ERRORLOG.md` §8.4。
13. **第四轮：外部渗透报告复核**（`D:\share\pentest-192.168.1.4`）。报告判定「业务逻辑扎实、风险全在部署层」，据此修掉 5 条发现：dev server 改绑回环 + 关 source map（F-01）、后端默认只监听 `127.0.0.1`（F-02）、`boundIp` 真正强制校验 + 修正 XFF 取值方向（F-03）、登录失败限流（F-04）、在线列表按关系收敛并去掉 `username`（F-05）。因为「回环」会挡掉局域网共享这个真实需求，进一步改成**后端单端口托管前端产物**（§1.52）：`npm run build` + `npm run start:lan` → `http://<本机IP>:3001` 就是完整应用，不泄源码、无代理、后端还能看到真实客户端 IP。复核中自己又踩出一个**全新库启动崩溃**（`addCol` 放在建表之前，§1.50），并清掉渗透残留的 2 个账号 + **3 把仍然有效的 API 密钥** + 2 条 IP 绑定 + 1 条待审提权申请（§1.51）。新增 `security_check.mjs`（29 项）、`static_host_check.mjs`（20 项）、`cleanup_test_data.mjs`。详见 `ERRORLOG.md` §10。
14. **第五轮：手机图片上传**（用户反馈「不支持手机图片和更多图片类型」）。实测出四个独立原因并全部修掉：新增 `client/src/utils/image.js` 在上传前统一「按 EXIF 方向解码 → 限长边 → 重编码」（10.90MB/4000×3000 直出照片 → 0.13MB/1024×768；EXIF=6 输出竖图）；白名单统一为 PNG/JPG/JPEG/GIF/WebP/BMP/AVIF，头像上限 5→8MB；三处 `accept` 改 `image/*`（否则手机相册里 HEIC 照片直接被置灰选不中）；拒绝文案改为从白名单现算。**服务端继续拒 HEIC/HEIF/TIFF**（桌面浏览器渲染不了，收了就是裂图）—— 手机端的 HEIC 由客户端转 JPEG 解决。顺带纠正报告「上传按文件魔数校验」的错误说法：服务端**没有**魔数校验。详见 `ERRORLOG.md` §11。
15. **第六轮：附件预览与商品图集**（用户需求：视频/音频内联播放、文件卡片用主流图标、实现可预览、详情页像京东）。附件按 MIME 分 `image/video/audio/file`：视频 `<video preload=metadata>`、音频 `<audio>`，**播不了自动退回卡片并提示**；新增 `FileTypeIcon.jsx`（simple-icons CC0 品牌路径内联，零依赖，11 类，同时删掉两套字母方块实现）；**把一直是空壳的商品「预览」真正接上**（`previewFileBlob` + `MediaPreviewModal`，未购买也能试看、下载仍需购买）；详情页做成京东式图集（封面 + 勾了预览的图片/视频，复用 `is_preview`，**不改库**）。后端 135 项、UI 定向回归 31 项全过。详见 `ERRORLOG.md` §12。
16. **第七轮：撤回改为直接删除**（不再显示「⚠️ 消息已撤回」）。服务端撤回从「UPDATE 成占位行」改成 **DELETE 消息 + 已读回执**（仍广播 `message:recalled`），前端收到就把这条从列表里 `filter` 掉；`isRecalled` 分支、`.message.recalled` 样式、右键菜单特判一并删除。**配套必做**：老库里的 `[消息已撤回]` 占位行会在启动时被清理（否则失去占位渲染后会以原始文本显示出来）。`socket_check` 46 项（+2：撤回后历史里查不到这条、且不存在占位行）。详见 `ERRORLOG.md` §13。
17. **第八轮：文件类型封面可配置**。把硬编码在 `FileTypeIcon.jsx` 里的类型表搬到 `utils/fileTypes.js`，并新增 `config.yaml → files.types`（`key/label/color/exts/cover`）+ `GET /api/file-types`：开发者遇到内置 11 类之外的扩展名（`.psd`/`.apk`…）可以**只改配置**新增类型并给它配一张**封面图**，重启后端即生效、**不用重新构建前端**；同 key 还能覆盖内置类型。非法配置只警告跳过、绝不让后端起不来。客户端用 `useSyncExternalStore` 订阅注册表，异步拉到之后**屏幕上已渲染的图标会自动重画**。新增 `file_types_check.mjs`（15 项）+ 前端临时 harness（21 项）。详见 `ERRORLOG.md` §14。
18. **第九轮：本地 ffmpeg 转码（任何格式都能播）**（用户要求：本地有 ffmpeg，添加任何格式都能播放）。新增 `services/transcode.js`：ffprobe 判「容器 + 编码」→ 需要就排队转码（编码 OK 只换壳，否则转 h264/aac 或 mp3）→ 副本落 `uploads/files/tc/`、**原件逐字节不动**；副本地址由源文件名确定性推导，所以**不改库、不改协议**。`POST /api/file` 当场回 `playback` 计划，客户端播放状态机 `direct → waiting → play/fallback`：转码中显示进度条、转好自动换播放器、服务端也救不了才退回卡片。商品试看走 `?playback=1`（`202` = 还在转 + 进度）。历史附件第一次被播放时自愈。新增 `transcode_check.mjs`（137 项，本机 ffmpeg 现场造素材 + 客户端状态机纯函数断言）。详见 `ERRORLOG.md` §15。
19. **第十轮：商城的「防顺手另存」**（用户要求：防止右键下载试看图 → 补充「首页卡片里的图也能右键下载」+「禁用 F12」→ 追问「为什么不直接全站禁用右键」）。前端新增 `ProtectedImage`（`contextmenu`/`dragstart` 双拦 + `draggable=false` + 透明盾 + 禁选中），覆盖**首页卡片封面 / 详情页图集 / 试看浮层**，视频·音频一并拦；新增 `utils/captureGuards.js`：拦 F12 / Ctrl+Shift+I·J·C / Ctrl+U / Ctrl+S，并**全站禁用浏览器默认右键菜单**（只 `preventDefault` 不拦冒泡 → 自定义菜单照常；输入框/可编辑区域豁免 → 粘贴照常）—— **只在生产构建安装**，`?dev=1` 可跳过。服务端给试看加**独立限流**（`rate_limits.preview`，60/分钟，与下载分开计数）与 `no-store`/`nosniff`。**代码与文档都写明：前端只是提高成本，不是安全边界**；卡片封面本身是静态公开文件，真正要保护得改走鉴权通道（未做，建议项）。顺带把 `cleanup_orphan_files.mjs` 加了「跳过最近 60 分钟改动过的文件」的熔断（差点删掉使用者正在上传的附件）。`smoke_test` 139 / UI 定向回归 17 + 24 + 14 + 生产产物探针 6 + 3 全过，详见 `ERRORLOG.md` §17。
20. **第十一轮：细节收口**（本轮）。按用户要求一次性处理了 **A1–A3 / B1–B2 / C1–C6 / D**：
    - **A1**：`ProductDetailModal.selectMedia` 的 `finally { setMediaNote('') }` 会遮蔽 `catch` 刚写入的错误消息 → 视频加载失败时用户看到空白；把清空挪到 `try` 成功路径末尾。
    - **A2**：`utils/room.js::roomPreview()` 只判 `image` / `file`，无文字的视频/音频消息在会话列表摘要为空 → 补 `video` / `audio`。
    - **A3**：`ApiKeysModal` 申请密钥请求在飞时（`creating`）点 ✕ / 遮罩 / Esc 都能关掉弹窗 → 服务端已下发的一次性明文永远拿不回来；三处都加 `!creating` 拦截。
    - **B1**：右键表情消息 →「购买表情包」原来跳到商城的「表情包」分类让用户自己找；现在 `ChatRoom` 的 `openBuy` 先调 `/api/stickers/lookup?url=` 反查 `productId`（`stickersApi.js` 新增 `lookupSticker()`），能查到就直开商品详情，查不到就明确提示。同时「复活」了那个此前永远不触发的 `stickerBuyProductId` 状态。
    - **B2**：`ShopPage` 的死 prop `me` 两侧都删掉。
    - **C1**：`buildMenuItems` 的 `useCallback` 依赖数组补 `token` 与 `openView`。
    - **C2**：`MessageBubble` 给 `FileTypeIcon` 传的 `mime={message.mime}` 恒 `undefined`（后端从不下发 `mime`），两处删掉。
    - **C3**：`AdminRoleRequestsTab` 的 `prompt(...) ?? null` 去掉多余的 `?? null`。
    - **C4**：`PluginHost` 卸载清票据改为「延迟 300ms 撤销、二次挂载时取消」，躲开 React StrictMode 的「挂载→卸载→挂载」把票据撤销掉的自伤（dev only，生产不受影响）。
    - **C5**：`client/package-lock.json` 的根节点（`name`/`version`/`react`）与 `package.json` 不一致 → 在 `client/` 跑一次 `npm install` 让 npm 重写。
    - **C6**：删掉 `server/package.json` 的死依赖 `@aiwayds/dsh-model-sync`（全项目从无 require，且带不必要的 `engines.node >= 22.19.0`）。
    - **D**：本轮**撤销**——用户要求「D 只登记脚本（`npm run test:*` 里注册的脚本）」。经核实 `server/scripts/sticker_pack_check.mjs`（23KB，2026-09-27）与 `plugin_check.mjs`（26KB，2026-09-28）**确实存在**，`test:stickers` / `test:plugins` 两个注册**有效**，并非无效注册。上一轮误判为「无效注册并从 `package.json` 删除」的做法**已回滚**：`server/package.json` 恢复这两行。这两脚本此前从未在 `DEVLOG §0` / §3 登记过，属**登记缺失**而非**脚本缺失** —— 已按「只登记脚本」的要求补入 §0 表格与 §3 验证小节（项数与是否自包含标「待补测」）。

## 5 审计轮结论（第 9 / 10 / 11 / 12 段）
只记「值得记住的判定」，细节见 §1 的 19–51 行。

- **服务端回归全绿**：`smoke_test` 121 / `room_icon_check` 41 / `socket_check` 44 = **206 项全通过**；另有 17 项针对本轮 5 处修复的隔离验证（自起 3002 端口，不污染正在运行的实例）。
- **前端**：`npm run build` 通过；`npm run lint` **0 error**（16 条 `set-state-in-effect` warning 是既有写法，见 §1.27）。
- **本轮最值得记的三条**：
  1. **来源 IP 必须来自可信渠道**（§1.36）：`X-Forwarded-For` 是客户端可随意伪造的头，凡是拿它当「身份/配额键」的逻辑（IP 绑定、失败次数、审计）都会被一击穿透。默认只认 `req.ip`，部署在反代后才开 `trust_proxy`。
  2. **`getGroupInfo` / `markRead` / `emitTyping` 三处缺的是同一类东西**：服务端只在「写操作」上做了权限校验，**读操作与副作用操作的「对象级授权」漏了**。新加接口时先问一句「调用者与这个对象有没有关系」。
  3. **测试脚本绝不能碰真实数据**（§1.42）：三个自检脚本原先会清空整张 `apikey_ip_claims`、删掉 `room_settings` 的 public 行、并留下提权后的测试账号。本轮实测就踩中一次（使用者的公共聊天图标被删，已还原）。规矩：**收窄到本套测试账号；改动共享状态前先快照、收尾还原**。
- **附件白名单**：`sendMessage` 只接受站内 `/uploads/...` 的 `fileUrl`（拒 `javascript:` / `data:` / 外链 / `..`）。前端上传流程本来就只产生 `/uploads/...`，**不要**为了让「外链附件」能用而放宽这条。
- **新接口字段**：`GET /api/shop/orders` 额外返回 `fileId` / `fileName` / `fileCount`，供前端走鉴权下载（`/uploads/shop` 不对外暴露，**不要**改回裸链）。
- **权限位**：官方市场上架改为校验 `official_publish`（原先只校验 `list_products`）。当前 `config.yaml` 两者都是 50，**行为不变**，属语义修正 / 预留。
- **`/health` 陷阱**：`app.js` 里不能加全局 catch-all 404，否则会吃掉 `index.js` 在 `app` 之后注册的 `/health`；只挂 `/api` 级兜底。
- **socket 层约定**：新加 handler 一律写成 `socket.on('x', (payload = {}, ack) => ...)` 并对 `roomType`/`roomId` 做类型校验；`socket/index.js` 的 try/catch 只是安全网，不能替代入参校验。
- **CSS 层教训（§1.33/34，已进 §2 规则清单）**：① 泛化标签选择器（`.nav-row > span`）会命中组件根节点 —— `Avatar` 就是 `<span>`，且 `flex` 简写会把 `flex-basis` 变 `0%` 从而**压过内联 width**；② 整页模式下的图标网格必须自己限宽，因为 `.view > .modal-overlay > .modal-card` 被 `width:100%!important` 摊平。
- **验证方式**：UI 修复用「静态 harness + 无头 Edge `--dump-dom` + 对照组」测几何（按钮 `160×160`/网格 `1310px` → `59×59`/`520px`），比截图更可靠且当前模型可读。
- **误报备查**（均为逐一核实后确认「不是 bug」，避免以后重复追）：① `ListPanel` 的 `onAccept(r.id)` → `ChatRoom` 已包成 `{ requestId }`，契约正确；② `AdminAuditTab` 的 `targetType === 'user' ? '用户' : '商品'` 本身就是对的；③ `PublicRoomIconModal` 用 REST 而非 socket —— REST 路由 `PUT /api/rooms/public/icon` 真实存在；④ `AdminApiKeysTab` 的 `load()` 用的是当前渲染闭包里的 `all`，不是陈旧值；⑤ `ChatInput` 的 `draft` 看似会串房间，但 `ChatRoom` 传了 `key={activeKey}`，切房间会整体重挂载。
- **已知未修**：① 头像 / 图标允许 `http(s)` 外链（第三方可获知查看者 IP，属文档化能力）；② 预期内的 4xx 也打完整堆栈；③ 仍无 `process.on('uncaughtException' | 'unhandledRejection')`；④ 缺索引 / N+1 / 群解散不清理孤儿消息等优化项（`ERRORLOG.md` §8.4）；⑤ `list_products: 50` 与「跳蚤市场=用户自主上架」文案矛盾，涉及放宽权限，待确认。
- **新增依赖**：无（新增文件 `server/src/utils/url.js`）。**数据库结构**：无变更。逐条清单见 `ERRORLOG.md`。

## 6 第四轮结论（外部渗透报告复核）

- **回归全绿**：`smoke_test` 125 / `socket_check` 44 / `room_icon_check` 41 / `security_check` **29** = **239 项全通过**；前端 `build` 通过、`lint` 0 error / 16 warning。逐条清单与定向证据见 `ERRORLOG.md` §10。
- **本轮最值得记的四条**：
  1. **部署层才是这个项目的真实攻击面**（§1.44/45）：业务逻辑（越权 / 注入 / 上传 / 路径穿越 / JWT 伪造）在渗透报告里全部被挡住，5 条发现里有 4 条来自「把开发环境暴露到网络」。默认值必须是安全的：dev server 与后端一律缺省回环。**但「缺省回环」不等于修完** —— 需求（局域网共享）还在，必须给出不泄露源码的正路：`npm run share`（构建产物 + preview + 同一份代理），否则使用者只会自己把 dev server 开回 `0.0.0.0`，等于没修。
  2. **「记下来」不等于「校验」**（§1.46）：`boundIp` 写进了库和响应，看着像个控制，实际一次都没比对。任何绑定/配额都要问一句「读取时的校验点在哪」。
  3. **同一个安全机制的两个端点都要能挡住**（§1.47）：F-03 的复现是「双向都通过」——只堵一边的 IP 绑定没有意义。修完必须用**两个真实来源 IP** 正反各测一次（`security_check.mjs` 就是这么做的）。
  4. **测试与渗透的残留会真的咬人**（§1.51）：渗透留下的 3 把密钥仍然有效，其中 `sectest` 占着 `127.0.0.1` 这条 IP 绑定，直接把 `smoke_test` 的密钥申请顶成 403 —— 我是先被它绊了一跤才发现残留的。清残留用 `cleanup_test_data.mjs`，别手写 SQL。
- **自己引入的回归**：给 `api_keys` 加列时把 `addCol` 放错了位置，**全新库启动直接崩**（§1.50），老库完全不复现。新写的隔离实例用例（临时空库起实例）当场抓住 —— 这条用例值得长期保留。
- **保留的取舍**：JWT 仍是 7 天 + `localStorage`（改 Cookie/刷新令牌属认证架构改造，未动）；登录限流是进程内计数（多实例部署需换共享存储）；`security.trust_proxy` 仍默认 `false`（只有当后端确认不可直连时才该开）。详见 `ERRORLOG.md` §10.4。
- **新增文件**：`server/src/auth/loginGuard.js`、`server/scripts/security_check.mjs`、`server/scripts/static_host_check.mjs`、`server/scripts/cleanup_test_data.mjs`。
  **部署形态**：局域网共享改为**后端单端口托管前端产物**（`client.serve` + `npm run start:lan`）；client 侧保留 `dev`（回环 HMR）与 `dev:lan`（对外 HMR，泄源码），`vite preview` 不再作为共享路径。

## 7 第五轮结论（手机图片上传）

- **回归全绿**：`smoke_test` 125 / `socket_check` 44 / `room_icon_check` 41 / `security_check` 29 / `static_host_check` 20 / `upload_format_check` 25 / `image_check` 15 = **299 项**；前端 build 通过、lint **0 error / 16 warning**。
- **本轮最值得记的三条**：
  1. **「不支持」要先复现再动手**（§1.55）：用户说「不支持手机图片」，实测出来是**四个**独立原因（体积上限 5MB、无压缩、无 EXIF 处理、`accept` 把选择器限死），只改其中任何一个都还是「传不了」。
  2. **手机照片的两件必做事：压缩 + 按方向解码**（§1.55）：不压缩就撞体积上限，不管方向上传后就是横躺的 —— 而 EXIF 方向**只在重编码时才会丢**，所以必须在解码时带 `imageOrientation:'from-image'`。
  3. **「支持 HEIC」不是把 HEIC 加进白名单**（§1.56）：桌面浏览器渲染不了，收了就是裂图。正解是客户端转码 + 服务端继续拒 + 文案告诉用户怎么办。
- **格式白名单的唯一真相**：`config.yaml`（`uploads.avatar.allowed_ext`、`business.assets.allowed_ext/allowed_mime`）+ `services/assets.js` 的 `MIME_EXT`；**拒绝文案从白名单现算**，改配置不用改文案（§1.57）。
- **顺手纠正一处错误认知**：报告说「上传按文件魔数校验」不成立 —— 服务端没有魔数校验（§1.59）。将来要做「防伪装扩展名」得自己加。
- **新增文件**：`client/src/utils/image.js`、`server/scripts/image_harness.html`、`server/scripts/image_check.mjs`、`server/scripts/upload_format_check.mjs`。
  **新增配置项**：无（只改了白名单取值与 `uploads.limits.avatar`）。**数据库结构**：无变更。

## 8 第六轮结论（附件预览与商品图集）

- **回归全绿**：`smoke_test` 135 / `socket_check` 44 / `room_icon_check` 41 / `security_check` 29 / `static_host_check` 20 / `upload_format_check` 25 / `image_check` 15 = **309 项**；另有 **31 项 UI 定向回归**（无头 Edge 渲染真实组件，临时脚本跑完已删）。前端 build 通过、lint **0 error / 16 warning**。
- **本轮最值得记的三条**：
  1. **需求里「实现可预览」其实服务端早就有了**（§1.60）：`/api/shop/preview` 一直存在且只放行 `is_preview=1`，缺的只是前端调用 —— 动手前先 grep 一遍接口，能省掉一半工作量，也避免重复实现一套。
  2. **「试看」与「下载」是两条权限**（§1.60）：未购买时应该**只隐藏下载、保留预览**，这才是「京东式」的模型；把两者绑在一起是不对的。
  3. **媒体的「播不了」必须显式回退**（§1.60）：浏览器对 `avi/mkv/flac` 不保证能解，只有真去加载才知道；不留坏播放器、静默失败，而是退回文件卡片 + 一句可执行提示。
- **图形资产的取法**：品牌图标从 **simple-icons（CC0-1.0）** 取路径数据内联，零运行期依赖、不请求外网；自绘通用的文本/代码/音频/视频/图片/兜底图形。项目规则「图标只用内联 SVG、禁用 emoji」继续保持（顺手修掉了 `ChatInput` 里遗留的 📎）。
- **新增文件**：`client/src/components/common/FileTypeIcon.jsx`、`client/src/components/common/MediaPreviewModal.jsx`。
  **删除的实现**：`utils/fileUtils.js` 的 `getFileMeta()` / `getShopFileIcon()`（两套字母方块，已统一到 SVG 图标）。
  **数据库结构**：无变更（图集复用 `product_files.is_preview`）。**新增依赖**：无。

## 9 第七 / 八轮结论（撤回直接删除 · 文件类型封面）

- **回归全绿**：`smoke_test` 135 / `socket_check` 46 / `room_icon_check` 41 / `security_check` 29 / `static_host_check` 20 / `upload_format_check` 25 / `image_check` 15 / `file_types_check` 15 = **326 项**；另有两轮 UI 定向回归（31 + 21 项，无头 Edge 渲染真实组件，临时脚本跑完已删）。前端 build 通过、lint **0 error / 16 warning**。
- **本轮最值得记的三条**：
  1. **改语义必须同时管老数据**（§1.63）：撤回从「占位」改成「删除」后，历史占位行会以 `[消息已撤回]` 原始文本冒出来 —— 这是我自己新加的断言抓出来的，不是猜的。凡是改「旧数据怎么解释」，都要问一句「库里已经存在的那些怎么办」。
  2. **配置多写了坏条目不该崩**（§1.64）：`files.types` 一条写错只警告跳过；对照 §1.25，**缺关键项**才该直接抛错。这两条不矛盾，是两种不同的输入。
  3. **异步注册表要订阅**（§1.65）：模块级变量变化不会让纯函数组件重渲染，`useSyncExternalStore` 是正解；这类「拉到了但界面不更新」的 bug 在验收时很容易被漏掉，必须用真浏览器断言 DOM 变化。
- **顺手清掉的历史包袱**：`FileTypeIcon.jsx` 里为「一个文件同时导出函数与组件」而挂的 `eslint-disable react-refresh/only-export-components` —— 归类逻辑搬进 `utils/fileTypes.js` 后，那条 disable 就不需要了。
- **新增文件**：`client/src/utils/fileTypes.js`、`server/src/routes/fileTypes.js`、`server/scripts/file_types_check.mjs`。
  **新增配置**：`files.types`（默认空数组，不影响现有行为）。**数据库结构**：无变更。
  **数据库结构**：新增 `api_keys.bound_ip`（自动迁移；遗留密钥首个请求就地补写）。
  **新增配置**：`server.host`、`security.presence.scope`、`rate_limits.login.*`；`rate_limits.login` 与 `server.host` 都有代码兜底默认值，漏写不会崩。

## 10 第九轮结论（本地 ffmpeg 转码 · 任何格式都能播）

- **回归全绿**：`smoke_test` 139 / `socket_check` 46 / `room_icon_check` 41 / `security_check` 29 / `static_host_check` 20 / `upload_format_check` 25 / `image_check` 15 / `file_types_check` 15 / **`transcode_check` 137** = **467 项**；另有 **17 项 UI 定向回归**（无头 Edge 渲染真实 `MessageBubble`：占位 → 自动换可播副本 → 真的解出画面，临时脚本跑完已删）。前端 build 通过（117 模块）、lint **0 error / 16 warning**（基线不变）。逐条清单见 `ERRORLOG.md` §15 / §17。
- **本轮最值得记的四条**：
  1. **只产副本、绝不改原件**（§1.68）：转码服务的是「在线播放」，不是「替换文件」。下载与商品交付必须还是上传的那一份字节 —— 这条把它钉成设计前提，后面所有取舍（副本目录、`tc/` 命名、`?playback=1` 只影响预览）都是从它推出来的。
  2. **判「能不能播」不能看文件名**（§1.69）：`.mp4` 装 HEVC 播不了、`.mkv` 装 h264+aac 换个壳就能播 —— 只看扩展名会**同时**误判这两个方向。判定输入必须来自 ffprobe。
  3. **ffmpeg 的坑在「输出」不在「输入」**（§1.68）：输入什么都好说，输出写 `*.part` 时它会拿扩展名猜封装，猜不到就报 `Invalid argument`，而且退出码是 `4294967274`（`-22` 的无符号形式），第一眼很像权限问题。临时文件名 + 显式 `-f` 两个都要。
  4. **异步能力要配「状态出口」**（§1.70）：转码是后台跑的，客户端必须有个地方问「好了没、播哪个地址」。这个出口（`/api/media/status`）顺带解决了两件事 —— **历史附件自愈**（上线前的老附件第一次被播放时入队）与**不重复转码**（幂等），而这两件事都不是额外功能，是同一个接口的自然结果。
- **取舍**：副本占磁盘、转码吃 CPU（并发 2 / 单文件 30 分钟上限 / 队列 50 / 可配体积上限）；不做历史批量预转（懒转码）；不做清晰度选择；Office 文档仍不能在线预览（浏览器没有渲染器，转码救不了）。详见 `ERRORLOG.md` §15.4。
- **收尾：测试残留清理 + 清理工具加固**（§1.73/74）：本轮为回归跑了 `smoke_test`×2 + `socket_check` + `room_icon_check`，全打在真实库上，留下 **11 个测试账号 + 64 个无引用文件**（真实账号只有 1/2/3/167）。已全部清掉（`uploads/` 只剩 11 个文件、**全都有库内引用**，`integrity_check = ok`）。清理过程中我犯了一次错：手工写的孤儿扫描**漏了 `room_settings.icon`**，把公共聊天图标那个文件删了（它同时是用户 2 的头像）—— 已恢复，并把清理逻辑加固成「动态穷举引用面 + 删除前复查 + 默认只演练」。**并根治了残留本身**：三套打真实库的自检现在跑完自动收尾（删本套账号 + 清本次新产生的无主上传文件，`--keep` 可留现场），新增 `cleanup_orphan_files.mjs`（`npm run cleanup:orphans`）作为手动兜底。详见 `ERRORLOG.md` §16。
- **新增文件**：`server/src/services/transcode.js`、`server/src/routes/media.js`、`client/src/api/mediaApi.js`、`server/scripts/transcode_check.mjs`。
  **改动文件**：`server/src/config.js`、`server/config.yaml`、`server/src/routes/{index,user,shop,download}.js`、`server/package.json`、`client/src/utils/media.js`、`client/src/api/{index,shopApi}.js`、`client/src/components/chat/{MessageBubble,MessageList,ChatRoom,ChatInput}.jsx`、`client/src/components/shop/ProductDetailModal.jsx`、`client/src/components/common/MediaPreviewModal.jsx`、`client/src/styles/index.css`、`server/scripts/transcode_check.mjs`。
  **新增配置**：`media.transcode.*`（含代码兜底默认值，整段删掉也能启动）。**数据库结构**：无变更。**新增依赖**：无（ffmpeg 是外部可执行文件，不是 npm 依赖）。

## 11 第十轮结论（商城的「防顺手另存」）

- **回归全绿**：`smoke_test` **139**（新增 4 项：试看响应 `no-store` / `nosniff` / 限流生效 / 超限文案） + `socket_check` 46 + `room_icon_check` 41 + `security_check` 29 + `static_host_check` 20 + `upload_format_check` 25 + `image_check` 15 + `file_types_check` 15 + `transcode_check` 137 = **467 项**；另有 **UI 定向回归 17 + 24 + 14** 与**生产产物探针 6 + 3 项**（全是临时脚本，跑完已删）。前端 build 通过、lint **0 error / 16 warning**（基线不变）。逐条清单见 `ERRORLOG.md` §17。
- **本轮最值得记的四条**：
  1. **「防止右键下载」必须拆成「前端能拦的」与「前端拦不住的」**（§1.75/77）：右键另存 / 拖拽能拦；开发者工具、网络面板、拿 token 直接打接口拦不住。正解是「前端提高成本 + 服务端限流」，而且要**在代码注释与文档里写明这不是安全边界** —— 否则下一个人会把它当防盗措施，然后在真正需要防护的地方漏掉服务端那一层。
  2. **静态公开目录里的东西谈不上「保护」**（§1.77）：卡片封面在 `static.expose` 的 `covers/` 下（连登录都不要就能取），拦右键只是不让普通用户顺手点走。要真保护就得摘出静态暴露、改走鉴权 + Blob —— 这是唯一实质解法，牵动面见 §17.4。
  3. **「禁用 F12」只能做成「防误触」级别，且必须给自己留门**（§1.78）：快捷键拦得住、浏览器菜单拦不住，所以只在生产构建里装、`?dev=1` 可跳过，并断言「F5、Ctrl+C/V/A、单独按 u/s 一律不拦」，避免「为了防抓取把应用搞难用」。
  4. **「全站禁用右键」有两个口子不能堵**（§1.79）：拦冒泡会把**应用自己的自定义菜单**一起干掉（需求恰恰是「除自定义菜单外」）；连输入框一起禁会把**右键粘贴 / 手机长按粘贴**干掉。所以：只 `preventDefault` + 默认豁免输入框，两处都留成可配置的开关。
- **顺带**：清理工具加了「跳过最近 60 分钟改动过的文件」的熔断（§1.76）—— 差点删掉使用者**正在上传**的附件。
- **已知短板（未做，建议项）**：① 试看给的是**交付物原件**，彻底解法是服务端产出**降采样 + 水印**的派生图（复用 §15 的 ffmpeg 链路）；② 封面仍是静态公开文件。要不要做由使用者定：前者会让试看观感下降（分辨率、水印），后者要动 `static.expose` 与自定义类型封面。**连带效果**：右键全禁后，手机端长按保存**聊天照片**也失效（想保留就把 `.msg-image` 加进 `MENU_EXEMPT_SELECTOR`）。
- **新增文件**：`client/src/components/common/ProtectedImage.jsx`、`client/src/utils/captureGuards.js`、`server/scripts/cleanup_orphan_files.mjs`、`server/scripts/lib/cleanup_accounts.mjs`。
  **改动文件**：`client/src/main.jsx`、`client/src/components/common/MediaPreviewModal.jsx`、`client/src/components/shop/{ProductDetailModal,ProductCard}.jsx`、`client/src/styles/{index,shop}.css`、`server/src/routes/download.js`、`server/src/config.js`、`server/config.yaml`、`server/scripts/{cleanup_test_data,cleanup_orphan_files,smoke_test,socket_check,room_icon_check}.mjs`、`server/package.json`。
  **新增配置**：`rate_limits.preview`（缺省 60000ms / 60 次，代码有兜底）。**数据库结构**：无变更。**新增依赖**：无。

## 12 第十一轮结论（细节收口 · A/B/C/D 一次性处理）

- **本轮修复（10 项）**：
  - **A1** `ProductDetailModal.selectMedia` —— `finally` 里清 `mediaNote` 遮蔽 `catch` 的错误消息（真 bug，用户看不到失败原因）。
  - **A2** `utils/room.js::roomPreview()` —— 补 `video` / `audio`（真 bug，无文字的媒体消息摘要为空）。
  - **A3** `ApiKeysModal` —— 申请中（`creating`）三处出口（遮罩 / ✕ / Esc）都拦截（真 bug，一次性明文会丢）。
  - **B1** `ChatRoom::openBuy` —— 反查 `productId` 直开商品详情；`stickersApi.js` 新增 `lookupSticker()`；复活了此前永远不触发的 `stickerBuyProductId` 状态。
  - **B2** `ShopPage` —— 删死 prop `me`；`ChatRoom` 侧同步不再传。
  - **C1** `ChatRoom::buildMenuItems` —— `useCallback` 依赖数组补 `token` 与 `openView`。
  - **C2** `MessageBubble` —— 删两处 `mime={message.mime}`（恒 undefined）。
  - **C3** `AdminRoleRequestsTab` —— 删多余的 `?? null`。
  - **C4** `PluginHost` —— 卸载清票据改为「延迟 300ms + 二次挂载取消」，躲开 React StrictMode 自伤。
  - **C5 / C6 / D** —— `client/package-lock.json` 在 `client/` 跑 `npm install` 同步；`server/package.json` 删死依赖 `@aiwayds/dsh-model-sync`（**C6**）；**D 组撤销**：上一轮误判 `test:stickers` / `test:plugins` 为无效注册并删除，经核实两个脚本确实存在，`server/package.json` **恢复**这两行，并在 `DEVLOG §0` / §3 补登记（**不新建脚本、不删文件**）；`server/` 跑一次 `npm install` 同步 lock。
- **本轮最值得记的三条**：
  1. **`finally` 不该覆盖 `catch` 刚写的状态**（§1.86）：它只该做「无论如何都要做」的清理，不该做「成功路径才该做」的收尾。一旦混了，调试时最容易被误诊为「后端没返回错误」。
  2. **请求在飞时要挡住弹窗关闭**（§1.88）：涉及**一次性凭据**（API 密钥明文、分享码、上传结果）的交互，请求期间遮罩 / ✕ / Esc 三处都得拦 —— 卸载组件 = 用户永远拿不到服务端已经生成的东西，这是最阴的一类 bug。
  3. **React StrictMode 的「挂载 → 卸载 → 挂载」是 cleanup 设计的硬约束**（§1.85）：任何不可逆的 cleanup（清票据 / 注销资源 / 写库）都要么延迟 + 二次挂载取消，要么干脆挪出 cleanup。生产构建没 StrictMode，所以这类问题只在开发时暴露 —— **别因此忽略它**，因为它反映的是「cleanup 干了不该干的活」这个本质问题。
- **回归待补**：本轮改动**未重跑** `smoke_test` / `socket_check` / `room_icon_check` / `security_check` / `static_host_check` / 前端 `build` / `lint`。建议在 `client` 与 `server` 各跑一次 `npm install` 后，按 §3 的顺序全部重跑一遍（尤其 `smoke_test`，因为 `ApiKeysModal` 改动涉及密钥申请的交互路径；但那是前端组件，不影响服务端断言）。
- **改动文件**（10 个）：
  - `client/src/api/stickersApi.js`
  - `client/src/components/chat/ChatRoom.jsx`
  - `client/src/components/chat/MessageBubble.jsx`
  - `client/src/components/shop/ShopPage.jsx`
  - `client/src/components/shop/ProductDetailModal.jsx`
  - `client/src/components/admin/AdminRoleRequestsTab.jsx`
  - `client/src/components/plugins/PluginHost.jsx`
  - `client/src/utils/room.js`
  - `client/src/components/apikeys/ApiKeysModal.jsx`
  - `server/package.json`
- **新增配置**：无。**数据库结构**：无变更。**新增依赖**：无（反而是**删除**一个死依赖）。