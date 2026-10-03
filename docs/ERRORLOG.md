# ERRORLOG · realtime-chat 审计发现清单

> 本文件是**发现清单**（register），不是运行期日志 —— 运行期错误仍走 `console.error`。
> 每条 = 编号 / 严重级 / 位置 / 现象 / 根因 / 修法 / 状态。
> 根因的压缩版同步记在 `DEVLOG.md` §1（19–29 行）与 §5；本文件是可直接逐条复查的展开清单。

- **审计范围**：`server/src`（Express + node:sqlite + Socket.IO）、`client/src`（Vite + React 19）
- **基准**：本轮修复后 `chat.db` 结构无变更、接口仅新增返回字段、无新增依赖
- **状态图例**：`✅ 已修复` · `⚠️ 未修复（已知取舍）` · `❌ 误报（核实后确认不是 bug，未改动代码）`
- **严重级**：`严重` · `高` · `中` · `低`

---

## 1 安全漏洞

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-1 | 严重 | `server/src/services/assets.js:82-93`（原 `:68-74`） | `/uploads/../uploads-old/x.png` 被解析为 uploads 根**之外**的兄弟目录 | 越界判断写成 `abs.startsWith(path.resolve(UPLOAD_ROOT))`，**缺 `path.sep`**；`uploads-old` 与 `uploads` 前缀相同即通过。且未拒绝 `.` / `..` 段 | 新增 `isInsideDir()`（补 `path.sep` 比较，`assets.js:72-79`）；`absFromUrl` 逐段拒绝 `.` / `..` / `\0` | ✅ |
| SEC-2 | 严重 | `server/src/services/products.js:106-114`、`assets.js:311`、`products.js:220` | 卖家可把任意文件挂成商品素材；买家购买后经 `grantFromProductFile` 复制进 `uploads/custom/{buyerId}/`，而该目录**静态公开** → 任意文件读取后对外暴露 | 商品文件的 `files[].url` 完全由客户端提供，除 `absFromUrl` 外**无归属 / 存在性校验**；`grantFromProductFile` 也不限定来源目录 | 上架时强制「解析后落在 `SHOP_DIR` 且真实存在」；`grantFromProductFile` 与 `readBubbleTheme` 再各加一层 `SHOP_DIR` 限制 | ✅ |
| SEC-3 | 高 | `server/src/services/chat.js:78-87` | 非表情消息的 `fileUrl` 可存任意串（`javascript:` / `data:` / 外链 / 含引号），前端 `MessageBubble.jsx:166` 渲染成**可点击**的 `<a href>` | 只有 `isSticker` 分支校验 `/uploads/`，普通附件直接入库 | 统一白名单 `/^\/uploads\/[A-Za-z0-9_\-./]+$/`、拒 `..`、长度 ≤500；`fileName`/`fileType` 一并截断 | ✅ |
| SEC-4 | 中 | `server/src/db/seed.js:20` | 官方账户（`role='developer'`）的 `password_hash` 是手搓的 `$2a$10$` + 随机 base64 | 依赖 bcrypt 对**不合规哈希**的解析行为，属实现细节；该账户权限最高 | 改 `bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10)` | ✅ |
| SEC-5 | 低 | `client/src/components/common/Avatar.jsx:34-43`、`server/src/utils/avatar.js:27-29` | 头像 / 房间图标允许 `http(s)://` 外链 | 外链是文档化能力（`/uploads/`、`http(s)`、`data:image/`、单字符四态） | 未改：`<img>` 不执行 SVG 脚本，非 XSS；影响是**第三方图床可拿到查看者 IP**（隐私）。如需收紧请明确 | ⚠️ |

> SEC-3 备注：实测 React 的 `sanitizeURL` 会把 `javascript:` 换成抛错桩、浏览器拦截 `data:` 顶层跳转，因此**并非可直接利用**；按纵深防御修掉，避免依赖框架 / 浏览器行为。

---

## 2 功能性 Bug

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| BUG-1 | 高 | `client/src/components/shop/ShopPage.jsx:101-121,276`；`server/src/routes/shop.js:246-256` | 「我购买的」下载按钮**永不渲染** | 前端判 `o.fileUrl`，但 `/shop/orders` 的 SELECT 从未下发该字段（商品文件在 `uploads/shop`，也不该给裸链） | 接口补 `fileId`/`fileName`/`fileCount`；前端改走鉴权 `downloadFile()` | ✅ |
| BUG-2 | 中 | `client/src/components/admin/AdminReviewTab.jsx:33-38,81` | 免费商品在管理端**无法定价上架** | 卡 `price < 1` + `min={1}`，与 `config.yaml` `price.min: 0`、`FEATURES.md`「审核时可定价为 0」、以及同项目 `UploadProductModal.jsx:124`「0 = 免费商品」**三处全部矛盾** | 放宽到 `0`，`min={0}` | ✅ |
| BUG-3 | 中 | `client/src/components/admin/AdminReviewTab.jsx:65-73` | 待审核列表的「查看文件」链接永不渲染（死代码） | 读 `p.fileUrl`/`p.fileName`，但 `/admin/shop/pending-review` 只下发 `fileCount` | 改为显示文件数量（用 `Icon` 组件，遵守「禁用 emoji 当图标」规则） | ✅ |
| BUG-4 | 中 | `client/src/components/admin/AdminUsersTab.jsx:29-38` | 点「取消」后**封禁 / 禁用照样执行** | `prompt(...) \|\| ''` 把取消返回的 `null` 变成空串，丢失「取消」语义 | 判 `input === null` 提前 `return` | ✅ |
| BUG-5 | 中 | `server/src/socket/handlers/group.js:54-61`；`client/src/components/contacts/GroupInfoModal.jsx:35-37,73-80` | 踢人后成员列表可能**不刷新**；失败无任何提示 | 服务端 `group:kick` 无 ack；`ChatRoom` 收到 `group:updated` 后重发 `group:info` 用的是**空 ack 回调** `()=>{}`，模态框拿不到结果 → 前端只能 `setTimeout(load, 200)` 猜时间 | 服务端补 ack；模态框自行监听 `group:updated` 事件驱动刷新 | ✅ |
| BUG-6 | 中 | `server/src/auth/apikey.js:141-196`；`server/src/routes/download.js:16-46` | 按 `keyId` / IP / `userId` 的限流 `Map` **只过滤不删键**，长期运行内存只增不减（也是 DoS 面） | 缺整键清理 | 加 `prune()` + `unref()` 定时器（每 500 次操作或 5 分钟） | ✅ |
| BUG-7 | 中 | `server/src/routes/download.js:36-41` | 超限分支**丢弃**裁剪后的数组，过期时间戳持续堆积 | 早退分支未写回 | 超限时也写回裁剪结果 | ✅ |
| BUG-8 | 中 | `client/src/components/shop/ShopPage.jsx:38,45-48,165` | 搜索框**每敲一个字打一次接口**；响应乱序时旧关键词结果覆盖新结果 | `keyword` 直接进 `load` 的依赖数组 | `keyword` / `query` 分离 + 300ms 防抖；回车立即生效 | ✅ |
| BUG-9 | 低 | `CreateGroupModal.jsx:31-34`、`JoinGroupModal.jsx:20,27-30` | 断线时 `socket.emit` 抛错 | 缺 `!socket` 守卫（`AddFriendModal` 有，这两个没有） | 补守卫并提示「连接已断开」 | ✅ |
| BUG-10 | 低 | `client/src/components/shop/PointsHistoryModal.jsx:9,21,59` | 接口失败**静默吞异常**，余额永远显示「—」且无提示 | `.catch(() => {})` | 记录并渲染错误 | ✅ |
| BUG-11 | 低 | `client/src/components/chat/ReplyBar.jsx:2` | `replyTo` 为空时渲染崩溃 | 无空值保护 | 补 `if (!replyTo) return null;` | ✅ |
| BUG-12 | 低 | `client/src/components/stickers/StickerPackManager.jsx:21,146-149` | 面板提示「单次最多 50 张」，但客户端**不强制**（只有服务端拒） | 只校验了单张 10MB | 补 50 张上限，超出取前 50 并提示 | ✅ |
| BUG-13 | 低 | `client/src/hooks/usePreferences.js:68` | 每次挂载多一次无用渲染；`loading` 无人消费 | 死状态 + effect 内同步 `setState` | 删除 `loading` | ✅ |
| BUG-14 | 低 | `ProductDetailModal.jsx`（props 签名）、`ChatRoom.jsx`（原 `:57` / `:171`） | 未使用变量：`me` prop、`myGroupRequests` 状态 | 遗留 | 删除 | ✅ |
| BUG-15 | 低 | `client/src/App.jsx:35` | 硬编码 `localStorage` 键名 `'chat_user'`，与 `authStorage.js` 各写一份 | 绕过封装 | 改走 `saveAuth()` | ✅ |
| BUG-16 | 低 | `server/src/services/preferences.js` | 死代码：遍历 `raw` 的空 `if` 循环 + 仅被它引用的 `SIDE_KEYS` | 遗留 | 删除，改为注释说明「白名单天然忽略未知字段」 | ✅ |
| BUG-17 | 严重 | 原 `server/src/socket/index.js:19`（现 `:22-30`）；`server/src/socket/handlers/presence.js:28` | **改一次昵称 / 头像即打崩整个后端**：`user:refresh` 执行到 `onlineUsers.get()` 抛 `TypeError`，handler 无 try/catch → `uncaughtException` → 进程退出，全站掉线 | `registry.js` 把 `onlineUsers` 作为**模块私有** Map 持有、只导出 getter `getOnlineUsers()`；`socket/index.js` 却写成解构 `const { onlineUsers } = registry` → `undefined`。socket handler 又是唯一没有异常兜底的入口 | ① 改用 `registry.getOnlineUsers()`；② `socket/index.js` 给每个 handler 统一包 try/catch（安全网，以后新增处理器自动受保护）；③ `presence.js:28` 加 `?.` | ✅ |
| BUG-18 | 高 | 全部 `server/src/socket/handlers/*.js`（25 个事件） | 无 payload / 畸形 payload 的 socket 事件（例：`socket.emit('group:info')`、`emit('typing:start',{roomType:'private'})`）会让 handler 解构 `undefined` 抛错；与 BUG-17 叠加 = **任一登录用户发一个包就能打崩服务** | 除 `group:kick/update/member:role/room:public:icon` 外，其余 handler 都写成 `({ x })` 无默认值；`emitTyping` 直接把 `roomId` 当字符串用 | 25 个 handler 全部补 `= {}`；`emitTyping` 增加 `roomType`/`roomId` 类型校验；`typing:start/stop` 补默认值 | ✅ |
| LOG-1 | 低 | `server/src/routes/shop.js:164` 等路由 catch | 预期内的 **4xx 校验失败**也用 `console.error` 打完整堆栈（烟测跑一遍就刷出「外观素材至少需要一张图片文件」「自主定价需为 0-100000」两条堆栈），真异常会被淹没 | 路由 catch 不区分「用户输入错误」与「真·服务端异常」 | 未改（属运行期日志范畴，本轮未选）；建议 4xx 记单行 `warn`、仅 5xx 记堆栈 | ⚠️ |

---

## 2.5 界面 / 布局（用户反馈）

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| UI-1 | 中 | `client/src/styles/index.css:425`（原） | 左侧导航「最近会话」浮层里的头像 —— 尤其**群图标** —— 被撑满整行，上传的图片再经 `object-fit:cover` 放大，看上去「图标太大 / 缩放不对」；行内的在线状态点同样被撑宽 | `.nav-row > span { flex: 1 }` 泛化命中了它不该命中的元素：**`Avatar` 组件的根节点恰好就是 `<span>`**（`.dot` 也是）。而 `flex` 简写把 `flex-basis` 设为 `0%`，**flex-basis 一旦不是 `auto` 就会压过内联的 `width: 28px`**，于是头像被拉宽 | 选择器收窄为 `.nav-row > span:not(.avatar):not(.dot)`，并显式加 `.nav-row > .avatar, .nav-row > .dot { flex: 0 0 auto }` | ✅ |
| UI-2 | 中 | `client/src/components/auth/AvatarEditor.jsx`；`index.css` 新增 `.avatar-editor` | 个人信息页的 emoji 选择网格摊满整屏，每个按钮 **160×160**，观感很散 | 弹窗转整页的既有机制把 `.view > .modal-overlay > .modal-card` 设为 `width:100%!important`（`index.css:486`）；`AvatarEditor` 把 `.avatar-grid` 直接放进该 card，**没有任何限宽**。群图标那边有 `.room-icon-editor{max-width:520px}`，所以只有个人信息页出问题 | 新增 `.avatar-editor` 容器，并把 `.room-icon-editor` 的限宽 / 面板底色 / 居中 / 按钮样式与它**共用同一组选择器**，两处观感一致 | ✅ |
| UI-3 | 低 | `client/src/components/auth/AvatarEditor.jsx`（提示文案） | 提示写「支持 PNG / JPG / GIF / WebP / **SVG**」，但用户选 SVG 会被服务端拒绝 | 服务端 `middleware/upload.js` 明确 `if (file.mimetype === 'image/svg+xml') return cb(new Error('不支持 SVG 头像'))`，且 `uploads.avatar.allowed_ext` 不含 `.svg`；提示与实现不符 | 文案改为「PNG / JPG / GIF / WebP（≤5MB）」，与群图标选择器一致；上传按钮补 `Icon name="image"` 保持一致 | ✅ |

---

## 3 错误处理与健壮性

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| ERR-1 | 中 | `server/src/app.js:64-89` | 未匹配的 `/api/*` 与未捕获异常返回 **HTML**（含堆栈） | 既无 404 兜底也无错误中间件 | `/api` 级 JSON 404 + 全局 JSON 错误处理；**注意不能加全局 catch-all —— 会吃掉 `index.js` 后注册的 `/health`** | ✅ |
| ERR-2 | 中 | `server/src/config.js:98-147` | `security.blocked_ext` 缺失 / 非法时 `new RegExp(undefined)` 静默变成 `/undefined/`，会误拦文件名含 "undefined" 的上传 | 未校验类型、未捕获正则编译异常 | 启动时校验非空字符串 + 编译失败直接抛错；关键子配置补兜底默认值 | ✅ |
| ERR-3 | 低 | `server/src/routes/shop.js:113` | 官方市场（挂官方账户名下）只校验 `list_products`，未用专用能力位 | 语义错配 | 改为校验 `official_publish`。当前配置两者都是 50，**行为不变**，属语义修正 / 预留 | ✅ |
| ERR-4 | 低 | `client/eslint.config.js` | `npm run lint` 全项目飘红，lint 门失效 | `eslint-plugin-react-hooks` v7 新增 `set-state-in-effect`，把全项目「挂载后拉一次数据」的既有写法一律判 error | 该规则降级为 `warn`（提示保留）；另修 2 处真·未使用变量。现 **0 error / 16 warning** | ✅ |

---

## 4 测试与流程

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| TEST-1 | 中 | `server/scripts/{smoke_test,room_icon_check,socket_check}.mjs` | 三个自检脚本每跑一轮都会**残留测试账号**（`sm_` / `ric_` / `sk_` 前缀）及关联的商品 / 资源 / 积分 / 消息 / 群 | 脚本收尾只「释放 IP 绑定 + 还原 developer 角色与 room_settings」，**不删除自己创建的账号** | 当时手工清理（两次共清 18 个账号 + 40 个磁盘文件）。**第九轮收尾已彻底修掉**：新增 `scripts/lib/cleanup_accounts.mjs`，三个脚本跑完自动「删本套账号（复用 `cleanup_test_data.mjs`，含名下数据与上传文件）+ 清本次新产生且无人引用的上传文件」，想保留现场加 `--keep`（详见 §16） | ✅ |
| TEST-3 | 高 | `server/scripts/cleanup_test_data.mjs`（清理工具自身） | 第九轮验证跑完两轮套件后，真实库里留下 **11 个测试账号 + 64 个无引用文件**；清理时又因为**引用面列漏了 `room_settings.icon`**，把正在使用的公共聊天图标文件当孤儿删掉了 | ① `smoke_test` 收尾不删账号（TEST-1 未修）；② 清理工具只收集「目标账号名下的行」引用的文件，**其它行引用同一文件的情况（如公共图标指向某账号头像）没有护栏**；③ 我手工写的孤儿扫描漏了 `room_settings.icon` / 偏好里的背景图这类「藏在文本里的路径」 | 已恢复被误删的图标文件；`cleanup_test_data.mjs` 补「删文件前再查一遍全库引用，仍被引用的一律保留」+ 补收集群图标与偏好背景；新增 `cleanup_orphan_files.mjs`（动态遍历**所有表**、从每行 JSON 抠 `/uploads/` 路径，默认只演练）作为兜底，`npm run cleanup:orphans`。详见 §16 | ✅ |
| TEST-5 | 低 | `server/package.json` | `dependencies` 里有 `@aiwayds/dsh-model-sync`，全项目**没有任何 `require` / `import`**；它还给项目引入了不必要的 `engines.node >= 22.19.0` 隐性约束（项目自身是 `>= 22.5.0`），并拖着 6 个 `@deepseek-ai/*` peerDependencies | 早期试装未清理 | 从 `dependencies` 删掉；`server/` 跑一次 `npm install` 同步 `package-lock.json` | ✅ |

---

## 5 误报备查（核实后确认不是 bug）

记录在此**避免以后重复追查**。这些均未改动代码。

| 编号 | 被报位置 | 报告的说法 | 实际核实结果 |
| --- | --- | --- | --- |
| FP-1 | `client/src/components/chat/ListPanel.jsx:101,102,155,156` | 「`onAccept(r.id)` 传裸 id，与 `{requestId}` 契约不符，会破坏好友 / 群申请」 | ❌ **契约正确**。`ListPanel` 只把 `r.id` 交给父组件；`ChatRoom` 的 `acceptFriend(requestId)` 内部发的是 `socket.emit('friend:accept', { requestId })`，`group:approve/reject` 同理 |
| FP-2 | `client/src/components/admin/AdminAuditTab.jsx:43` | 「三元表达式反了，`targetType === 'user'` 会显示"商品"」 | ❌ **本身就是对的**。源码为 `l.targetType === 'user' ? '用户' : '商品'` |
| FP-3 | `client/src/components/rooms/PublicRoomIconModal.jsx:25-37` | 「用 REST 而非 socket，若服务端只有 socket 事件则调用失败」 | ❌ **REST 路由真实存在**：`PUT /api/rooms/public/icon`（`server/src/routes/rooms.js:16`），且与 socket 版共用 `services/rooms.js` |
| FP-4 | `client/src/components/admin/AdminApiKeysTab.jsx:21,56` | 「`load()` 用了陈旧的 `all` 闭包」 | ❌ **不陈旧**。`release` 与 `load` 都是每次渲染重新创建的，点击时执行的是最新渲染的闭包，`all` 即当前值 |

---

## 6 验证证据

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 后端主自检 | `cd server && node scripts/smoke_test.mjs` | **120 / 120** |
| 房间图标权限 | `cd server && node scripts/room_icon_check.mjs` | **41 / 41** |
| 实时 socket（含密钥通道） | `cd client && node ../server/scripts/socket_check.mjs` | **43 / 43**（37 → 43，新增 §5.5 崩溃回归） |
| 前端构建 | `cd client && npm run build` | 通过（112 模块） |
| 前端 lint | `cd client && npm run lint` | **0 error** / 16 warning |

定向验证（临时脚本，均已删除）：

| 验证内容 | 结果 |
| --- | --- |
| SEC-1 路径：`..` 越界 / `uploads-old` 前缀逃逸 / `.` 段 / 反斜杠 全部返回 `null`；`isInsideDir('…/uploads-old/…','…/uploads')` = `false` | 通过 |
| SEC-2 商品文件：`../chat.db`、`../config.yaml`、`uploads-old` 逃逸、资源池目录、不存在文件 —— 5 类全部 400 拒绝；正常 `uploads/shop` 素材仍可上架 | 24 / 24 |
| SEC-3 附件白名单：`javascript:` / `data:` / 外链 / `..` / 引号注入 / `vbscript:` 全部 400；正常 `/uploads/` 附件可发 | 8 / 8 |
| SEC-4 全新库 seed：官方账户角色 `developer`、哈希长度 60、7 个常见口令全部无法登录、重复 seed 幂等 | 8 / 8 |
| ERR-1 未匹配 `/api/*` 返回 JSON（非 HTML） | 通过 |
| BUG-1 订单带 `fileId`/`fileName`/`fileCount`，买家可用 `fileId` 走鉴权下载 | 通过 |
| BUG-17 `user:refresh` 后服务存活、socket 未断开、收到 `user:updated` 广播 | 9 / 9 |
| BUG-18 29 个缺失 / 畸形 payload 之后服务存活，且仍能正常发消息 | 通过（已固化进 `socket_check.mjs` §5.5） |
| UI-1 / UI-2 几何断言：无头 Edge 加载**真实 `index.css`**，复现两种结构并测 `getBoundingClientRect` + `getComputedStyle` | 修复后：头像 `28×28`（`flexGrow:0 / flexBasis:auto`）、状态点 `8×8`、emoji 按钮 `59×59`（面板 `520px`）。对照组（修复前的结构）：网格 `1310px`、按钮 `160×160` | 通过 |

**收尾**：临时脚本、测试账号、测试数据、自起进程与磁盘测试文件均已清理；`chat.db` 已还原为原有 3 个账号（`党的好干部` / `狐本无忧` / `__official__`），`room_settings` 为空，3001 端口已释放。

---

## 7 未修复项一览（需你决策）

1. **SEC-5** 头像 / 图标允许 `http(s)` 外链 → 第三方可获知查看者 IP。收紧会破坏文档化的「外链头像」能力，故未动。
2. **TEST-1** 三个自检脚本残留测试账号，建议补统一收尾（我可以直接做）。—— **第九轮已修**（见 §16）。
3. **ERR-4 的 16 条 warning** 若要彻底消除，需要把各组件 / hook 的「effect 内取数据」改写成外部订阅或数据层，属较大重构。
4. **LOG-1** 预期内的 4xx 也打完整堆栈，建议区分 4xx / 5xx 的日志级别（属运行期日志，本轮未选）。
5. **进程级兜底仍缺**：本轮用「handler 级 try/catch」堵住了 socket 这条路，但 `server/src` 依旧没有 `process.on('uncaughtException' | 'unhandledRejection')`。本轮未选该项，故未加。

---

# 第三轮：全项目深挖（漏洞 / 错误 / 可优化）

本轮覆盖前两轮**没细看**的面：服务端授权与来源可信度、scripts 与 Python 工具链、客户端剩余 20 个组件、以及优化项。
标注规则：`已实测` = 我写了 PoC 跑出证据；`已核实` = 逐行读代码确认；`待复核` = 子代理报告、我未独立验证。

## 8.1 服务端安全（已实测复现 → 已修复）

| 编号 | 级别 | 位置 | 实测证据 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-6 | 高 | `server/src/utils/ip.js:18-22` | PoC：A 用 `XFF:1.1.1.1` 绑走 IP；B 用同一 XFF 被正确拒 403，但**改成 `XFF:2.2.2.2` 即 201 绕过**（同一台机器）。另：同一 XFF 连失 35 次会 429，**轮换 XFF 连失 45 次全程无 429** | `clientIp()` **无条件采信 `X-Forwarded-For`**（客户端可随意伪造）。它同时是 `apikey_ip_claims` 的键与 `ipFailures` 的键，于是一击废掉两道防护：IP 绑定形同虚设、密钥暴力枚举不受限 | 新增 `security.trust_proxy`（默认 `false`）；`app.js` 设 `app.set('trust proxy', TRUST_PROXY ? 1 : false)`；`utils/ip.js` 仅在信任代理时才读 XFF，否则只认 `req.ip`／TCP 对端；`routes/download.js` 删掉自己那份读 XFF 的实现，改用同一工具（审计日志同步修好） | ✅ |
| SEC-7 | 中 | `server/src/services/chat.js:308`（`getGroupInfo`） | PoC：C（非成员）`GET /api/groups/<id>` → **200 且拿到完整成员名单** `["aud_..._a"]`。socket `group:info` 同一路径 | `getGroupInfo` 只查群是否存在，**没有任何成员校验**；返回体里含 `members`（用户名 / 昵称 / 头像 / 群内角色） | 非成员且非群主 → `403`。发现群聊走 `searchGroups`（只给群名/图标/人数），不受影响 | ✅ |
| SEC-8 | 中 | `server/src/services/chat.js:155`（`markRead`） | PoC：C（既非发送者也非接收者）`POST /api/messages/<id>/read` → `{ok:true}`，且 `readBy` 里真的写进了 C 的 id | `markRead` 只校验「消息存在 + 私有 + 自己不是发送者」，**没校验调用者是该私聊的参与者** | 解析 `p_a_b` 并要求 `parts.includes(user.id)`，否则 `{ok:false}` | ✅ |
| SEC-9 | 中 | `server/src/socket/handlers/message.js`（`emitTyping`） | PoC：C 发 `typing:start {roomType:'private', roomId:'p_<A>_<B>'}` → **B 收到 `typing:update`** | 私聊分支直接把 `roomId` 拆成 uid 群发，**不校验发送者在不在这个会话里**（群聊分支有 `isGroupMember`，私聊漏了） | 私聊分支加 `if (!parts.includes(user.id)) return;` | ✅ |
| SEC-10 | 低 | `server/src/services/products.js`（`createProduct`）、`stickers.js`（`createPack`/`updatePack`） | PoC：`coverUrl:'javascript:alert(document.cookie)'` 被**接受入库**，`GET /shop/products/:id` 原样回吐 | `cover_url` 完全由客户端直传、零校验（`<img src>` 不执行脚本，故非直接 XSS，但属不受控注入面 + 外链跟踪） | 新增 `server/src/utils/url.js` 的 `normalizeImageUrl()`：只收 `/uploads/…`（拒 `..`）、`http(s)`、`data:image`；商品与表情包封面统一走它 | ✅ |

## 8.2 工具链 / 脚本（已核实 → 已修复）

| 编号 | 级别 | 位置 | 问题 | 状态 |
| --- | --- | --- | --- | --- |
| TOOL-1 | **严重** | `server/scripts/init_accounts.py:31-46` | **把真实特权账号的明文密码写死在仓库里**：`党的好干部` → `党的好干部党的好干部`（role=**admin**）、`狐本无忧` → `13141314`（role=**developer**）。这两个账号就存在于当前 `chat.db`。文件头 docstring 与 `:248` 还会把它们打印出来 | ✅ 改为优先读 `INIT_ADMIN_PASSWORD` / `INIT_DEV_PASSWORD`，缺失则 `secrets.token_urlsafe(12)` 随机生成，并只在本次运行收尾时打印一次；docstring 里的明文一并抹掉 |
| TOOL-2 | 高 | `server/scripts/smoke_test.mjs:101` | `db.prepare('DELETE FROM apikey_ip_claims').run()` —— **无条件清空整张表**，把真实用户在管理端维护的 IP 绑定一起删掉；`:654-661` 还会遍历**全部**绑定逐个 release | ✅ 收窄为只删 `substr(username,1,3)='sm_'` 的测试账号；收尾只释放本套账号（判定用本次创建的用户 id 集合）的绑定 |
| TOOL-3 | 高 | `server/scripts/smoke_test.mjs:99` | 把测试账号 A 提为 `role='developer'` 后**从不还原**（另两个脚本有还原），留下特权残留 | ✅ 收尾新增 `UPDATE users SET role='user'` 还原 |
| TOOL-4 | 高 | `server/scripts/socket_check.mjs`、`room_icon_check.mjs` | 收尾**无条件删除 / 置空 `room_settings` 的 public 行** —— 会清掉使用者真实设置的公共聊天图标。**本轮实测踩中**：我的验证运行确实把它删了（已按删除前读到的原值还原） | ✅ 两个脚本改为**测试前快照、收尾还原原值**（socket_check 连 `updated_by`/`updated_at` 一起还原）；并撤销本套测试申请的 API 密钥 |
| TOOL-5 | 高 | `clean_history.py:51` / `init_accounts.py:50` / `scaffold.py:144` | 三个 Python 脚本在 stdout 被重定向（CI、`> log.txt`、`\| Tee-Object`）时抛 `UnicodeEncodeError: 'gbk' codec can't encode '\u26a0'` 并 **exit 1 中断**，无法在管道/日志场景使用 | ✅ 三处均加 `sys.stdout/stderr.reconfigure(encoding="utf-8", errors="replace")` |

## 8.3 客户端（子代理报告，抽样已核实）

未逐一实测，按可信度标注。**已核实**的我会在下方注明。

| 编号 | 级别 | 位置 | 问题 | 状态 |
| --- | --- | --- | --- | --- |
| CLI-1 | 中 | `shop/ProductCard.jsx:15` | `<img src={product.coverUrl}>` **未过 `resolveMediaUrl()`** —— 本组唯一漏掉的媒体渲染（ChatInput/AssetLibrary/StickerPicker/Appearance 都走了）。base URL 不同源时 `/uploads` 封面 404 | 待复核 |
| CLI-2 | 中 | `apikeys/ApiKeysModal.jsx:42,111,118` | 创建密钥的请求在飞时仍可关闭（✕ / 遮罩 / Esc 都没挡），卸载会丢掉一次性明文，而服务端**已经生成了一把可用密钥且用户永远看不到**（与 `:126` 的「只显示这一次」承诺矛盾） | **本轮已修**（见 §18 的 A3） |
| CLI-3 | 中 | `shop/UploadProductModal.jsx:83-93` | 循环里累积 `uploaded`，`setFiles` 在**循环之后**才执行 → 第 k 个文件失败会丢掉前 k-1 个已上传文件（服务端已落盘，UI 里没了） | 待复核 |
| CLI-4 | 中 | `stickers/StickerPackManager.jsx:81-84` | `openPack` 无过期响应保护：快速点 A 再点 B，可能 detail=A / 高亮=B | 待复核 |
| CLI-5 | 中 | `appearance/AppearanceModal.jsx:95,101,105` | 用户输入的色值 / 气泡素材地址未校验就拼进 CSS 变量与 `url("…")`；其中 `bubble` 还能来自**卖家可控**的商品 `theme.json`（`assets.meta`） | 待复核（`<img>`/CSS 不执行脚本，故是布局破坏 + 外链跟踪，非 XSS） |
| CLI-6 | 中 | `chat/ChatInput.jsx:19,36-38` | 子代理认为 `draft` prop 只读一次会串房间 | **经我核实为误报**：`ChatRoom` 给 `ChatInput` 传了 `key={activeKey}`，切房间会整体重挂载，`useState(draft)` 会重新初始化；`onDraftChange` 也是 `useCallback([])` 稳定引用 |
| CLI-7 | 低 | 多处 | `ApiKeysModal` 关闭时 in-flight、`AdminRoleRequestsTab` 无在途防重、`pendingCount` 不复位、静默截断文件、inline 回调导致监听器反复重绑 | 部分本轮已处理（`ApiKeysModal` 见 §18 A3）；其余待复核 |

## 8.4 可优化处（未实施，按性价比排序）

1. **缺索引**（读 `server/src/db/schema.js` 确认）——都只需一条 `CREATE INDEX`：
   - `products(file_hash)`：抄袭检测里 `WHERE file_hash = ?` 目前**全表扫描**
   - `group_members(user_id)`：`getGroups` 按 `user_id` 查，PK 是 `(group_id, user_id)`，用不上
   - `user_sticker_packs(pack_id)`：`subscriberIds` 按 `pack_id` 查
   - `group_requests(user_id)`、`friend_requests(from_id)`、`room_preferences(room_key)`
2. **N+1 查询**：`broadcastGroupUpdated` / `createGroup` 对每个成员各查一次 `getGroups`；`/admin/shop/pending-review` 每行一次 `COUNT(*)`（改用 JOIN + GROUP BY 一次拿全）。
3. **`users:search` / `groups:search` 用 `instr()`** → 无法走索引，全表扫描且无 socket 限流；群多时是 DoS 面。
4. **群解散不清理消息**：`leaveGroup`（群主解散）删了 `groups`/`group_members`/`group_requests`，**留下该群全部 `messages` 孤儿行**，`loadHistory` 也再读不到 → 库只涨不减。
5. **无注册限流**：`/api/auth/register` 可无限注册（每个号 50 积分）。注：因 `list_products: 50`＝仅管理员可上架，普通用户无法把积分转出，**故当前不构成刷分**；但账号垃圾与用户名占用仍无成本。
6. **`list_products: 50` 与 UI 文案矛盾**：`ShopPage` 把 flea 市场描述为「**用户自主上架**」，而能力位要求 50 级＝管理员——普通用户根本没有上架入口。疑为配置或文案错误，**涉及放宽权限，未擅自改**，见 §9 待你确认。
7. **前端无代码分割**：单 bundle 469KB（gzip 138KB），商城 / 管理 / 表情包等整页可 `React.lazy` 拆包。
8. **`hide`/`unhide`/`delist` 未做 `canOperate`**：50 级管理员可下架 90/100 级用户（含开发者）的商品，而 `/admin/users/:id/status` 是**有**同级保护的；且能力位 `delist_any: 90` 是死配置。
9. **仓库卫生**：无根 `.gitignore`、无 `client/.gitignore`（`node_modules/`、`dist/` 会被提交）；根目录 `scripts.zip`（含 `chat.db` 快照！）、`public.zip`、`client/logo.jpg`（与 `public/logo.jpg` 逐字节相同）均为死文件；`server/package.json` 的 `@aiwayds/dsh-model-sync` 依赖在源码中**从未被 require**（**本轮已删**，见 TEST-6）。
10. **`client/apply_update.py` + `update.md` 已成危险遗留**：`update.md` 是 19 个文件的旧快照，与当前文件逐块对比**至少 10 个已过期**（如 `api/index.js` 少 5 个导出、`ShopPage.jsx` 8298B vs 当前 10988B），而脚本默认**无确认直接覆盖** → 跑一次就回退 10 个文件。**本轮 D 未处理**（用户明确要求「D 只登记脚本」），仍为已知遗留。
11. `server/package.json` 无 `test` 脚本；`clean_history.py` 无 npm 入口；`scaffold` 脚本名与实际行为（只干跑）不符。
12. **`package.json` 与 `DEVLOG` 脚本清单不同步**：`scripts.test:stickers` → `sticker_pack_check.mjs`、`scripts.test:plugins` → `plugin_check.mjs`，两个脚本**都真实存在**（本轮已核实：分别创建于 2026-09-27 / 2026-09-28），但 `DEVLOG §0`（"现成回归脚本"表）与 §3 都从未登记它们。文档里 §0 又写着「改代码前先读 §0」，等于把这两套回归藏了起来。**修法：补登记**（脚本本身不动、`package.json` 也不动）。

## 8.5 本轮验证

| 验证项 | 结果 |
| --- | --- |
| 服务端 5 处修复（自起 3002 端口隔离验证） | **17 / 17 通过**（含「合法流程仍正常」的正向断言） |
| `smoke_test`（收窄清理后） | **121 / 121**（原 120，+1 为新增的角色还原断言） |
| `room_icon_check`（快照还原后） | **41 / 41**，且跑完**图标原值仍在** |
| `socket_check`（收窄清理 + 快照还原后） | **44 / 44**（原 43，+1 为撤销密钥断言），图标原值仍在 |
| 客户端构建 / lint | 通过 / **0 error** |

**本轮实测导致的真实数据损坏与恢复**：验证 `room_icon_check` 时，其收尾把我（使用者）真实设置的公共聊天图标删了。已按运行前读到的原值 `{"room_key":"public","icon":"/uploads/avatars/avatar_2_1790399842520.jpg","updated_by":2,"updated_at":1790399842546}` 完整还原，并顺手修掉了脚本本身的这个缺陷（TOOL-4）。**遗留小瑕**：`room_icon_check` 走 API 还原会把 `updated_by/updated_at` 改成测试账号，`socket_check` 走直连 DB 则完全还原——图标值本身两者都保住了。

## 9 需要你决策

1. **`list_products: 50` 是否符合预期？** 若「跳蚤市场 = 用户自主上架」是真实需求，应把该能力位降到 0（普通用户）并复核 `shop/upload`、`shop/cover` 的连带影响；这是**放宽权限**，我不擅自动。
2. **`hide`/`unhide`/`delist` 是否要补 `canOperate`？** 补上后 50 级管理员将无法处置 90/100 级用户的商品（与用户封禁逻辑一致）；`delist_any: 90` 也可顺势启用。
3. **是否删除死文件**：`client/update.md`、`client/apply_update.py`、`client/init_structure.py`、`server/scripts/scaffold.py`、根 `scripts.zip`（内含 `chat.db` 快照）、`public.zip`、`client/logo.jpg`。**（本轮 D 未处理，用户明确要求「D 只登记脚本」）**
4. **是否补索引 + 清理群解散的孤儿消息**（8.4 的 1、4）——纯收益、低风险，但会改库结构。
5. **是否移除未使用的 `@aiwayds/dsh-model-sync` 依赖**（会动 `package-lock.json`）。**本轮已删**，见 TEST-6。

---

# 第四轮：渗透测试报告复核（`D:\share\pentest-192.168.1.4`）

来源：外部渗透测试报告 `REPORT.md`（目标 `http://192.168.1.4:5173/` + 后端 `:3001`）。
报告结论「业务逻辑层的权限控制做得相当扎实，风险集中在基础设施部署层面」与本项目前几轮的判断一致：
越权 / 注入 / 上传 / 路径穿越 / JWT 伪造全部被挡住（报告 §三 逐项给了证据）。
本轮把报告的 5 条发现全部修掉，并顺手清掉了测试与渗透留下的残留数据。

## 10.1 报告发现（F-01 ~ F-05）修复清单

| 编号 | 级别 | 报告的说法 | 核实后的根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- |
| F-01 | 高 | dev server 绑 `0.0.0.0`，完整源码 + source map 泄露（还原出 55 个源文件） | `client/vite.config.js` 写死 `host: '0.0.0.0'`。dev 模式下 Vite 直接托管**整个工程目录**，每个模块内联 base64 source map（`sourcesContent` 是未压缩原文），`/package.json`、`/vite.config.js`、`/package-lock.json` 也都能直接下载 | `host` 改为 `process.env.VITE_DEV_HOST \|\| '127.0.0.1'`；`build.sourcemap: false` 显式写出；补 `server.fs.strict: true`；代理加 `xfwd: true`（见 F-03）。**并补上「局域网共享」的正路**（见 10.2 的 ARC-1）：只把默认值改回环不算修完 —— dev 模式对外服务**必然**泄露源码、没有开关能关，需求还在，使用者只会自己把 `0.0.0.0` 开回去 | ✅ |
| F-02 | 中高 | 3001 直接对局域网开放，可绕过 Vite 代理 | `index.js` 只写 `server.listen(port)` → Node 默认绑 `0.0.0.0`；`config.yaml` 里**根本没有 host 这一项**，无处可配 | 新增 `server.host`（默认 `127.0.0.1`）+ 环境变量 `HOST`；`index.js` 显式 `listen(PORT, HOST)` 并打印实际绑定地址；`config.js` 的兜底默认值同样钉死回环（绝不兜底成 0.0.0.0） | ✅ |
| F-03 | 中 | 密钥 `boundIp` 只记录不校验，IP 绑定形同虚设（双向都通过） | 申请密钥时把来源 IP 写进响应就完事，**使用时一次都没比对过**。另外 `utils/ip.js` 在信任代理时取的是 `X-Forwarded-For` 的**第一段**（客户端可随便写），方向取反了 | ① 迁移新增 `api_keys.bound_ip`；② `authenticateApiKey` 每次强制比对，不一致 → `403` + 审计 `apikey_ip_mismatch`；③ 迁移前的遗留密钥（NULL）首个请求就地补写，不锁死存量；④ `clientIp()` 改用 Express 已解析好的 `req.ip`，socket 握手这类没有 `req.ip` 的场景取 XFF **最后一段**（反代追加在末尾的那个才是真实对端） | ✅ |
| F-04 | 低中 | 登录接口无频率限制，12 次错误密码全是 401 | `POST /api/auth/login` 没有任何计数，成功失败都直接返回 | 新增 `auth/loginGuard.js`：按 **IP + 账号** 双维度滑动窗口（15 分钟内 IP 30 次 / 账号 10 次）→ `429` + `Retry-After`；成功登录清掉该账号计数（**保留** IP 计数，防止攻击者用一个可用账号把 IP 累计洗掉）；限流判定排在查库与 bcrypt **之前**，避免被拿计算量拖垮 | ✅ |
| F-05 | 低 | `/api/v1/state` 返回全站在线用户，构成用户枚举通道 | `registry.onlineList()` 对任何登录用户 / 任何有效密钥返回**全站**在线用户的 `id/username/nickname/avatar`；socket 的 `users:online` 还是全局广播 | ① 只给 `id/nickname/avatar`，**去掉 `username`**（那是登录标识，正是爆破要的原料）；② 按关系收敛：`relatedUserIds()` = 自己 + 好友 + 同群成员；socket 广播改为**逐连接下发各自可见的子集**；③ 新增 `security.presence.scope: related \| all` 逃生开关（默认 `related`） | ✅ |

> F-01 报告提到的「源码注释里直接给出 `curl -H "X-API-Key: ..."` 用法」不是独立漏洞 ——
> 注释本身没问题，**能被读到**才是问题，已随 F-01 一并封掉；顺手把 `apikeysApi.js` 里的示例
> 改成了当前实际的调用方式（后端只监听回环，脚本应走 5173 代理）。

## 10.2 复核过程中**新发现**的问题

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-11 | 高 | `server/src/db/schema.js` | **全新数据库启动直接崩**：`Error: no such table: api_keys`。这是本轮我给 `api_keys` 加 `bound_ip` 时**自己引入的回归**，被新写的隔离实例用例当场抓住（老库因为表已存在，完全看不出问题） | `addCol(db,'api_keys','bound_ip',…)` 被放进了「老库补列」区，而那段跑在 `api_keys` 的 `CREATE TABLE` **之前** | 移到 `setupSchema` 末尾（所有建表之后），并写明「给这批新表补列一律写在这里」 | ✅ |
| TEST-2 | 中 | `server/scripts/*` | 三个自检脚本每轮都残留测试账号（原 TEST-1，由 ⚠️ 转 ✅）；本次还证实**渗透残留更危险**：`sectest_*` / `massign_*` 两个账号 + **3 把仍然有效的 API 密钥** + 2 条 IP 绑定 + 1 条待审提权申请一直躺在库里，直接把 `smoke_test` 的密钥申请顶成 403 | 脚本收尾只释放绑定 / 还原角色，从不删自己建的账号；渗透方也没有执行报告 §五 的清理建议 | 新增 `scripts/cleanup_test_data.mjs`：默认**只演练**，`--apply` 才删，永远拒绝 id ≤ 3，按 id / 用户名前缀清账号 + 全部关联行 + `uploads/` 内的文件（逐段校验路径）。本次清掉渗透残留 + 本轮测试账号共 **13 个账号、38 个孤儿文件**，`chat.db` 回到 3 个真实账号 | ✅ |
| TEST-3 | 低 | `room_settings` | 测试脚本走 API 还原会把 `updated_by/updated_at` 改成测试账号（值本身没坏） | 原 §8.5 已记的「遗留小瑕」，脚本仍走 API | 本轮收尾已按测试前读到的原值（`updated_by=133, updated_at=1790402327749`）手工还原；脚本层面未改 | ⚠️ |
| ARC-1 | 中 | `server/src/app.js`、`server/config.yaml`、`server/index.js`、`client/*` | **只把 dev server 改成回环 = 把用户的真实需求堵死**（局域网共享是本应用的核心用法，见 F-01 修法）。当时前端只剩「dev 对外（泄源码）」与「只给自己用」两条路 | 没有「对外但不泄源码」的第三种形态 | **后端单端口托管前端产物**：`config.yaml → client.serve/client.dist`（默认 true / `../client/dist`）+ `app.js` 静态托管与 SPA fallback（顺序见 ARC-2）+ `npm run start:lan`（`node index.js --host 0.0.0.0`）。`config.js` 另加 `--host/--port` 命令行覆盖（PowerShell 不支持 `HOST=x npm start`）。client 侧删掉 `share`/`preview` 两条重复路径，只留 `dev`（回环 HMR）与 `dev:lan`（对外 HMR，明确泄源码） | ✅ |
| ARC-2 | 高 | `server/src/app.js` | 前端静态段与 SPA fallback **挂载顺序错了会静默出事**：挂在 `/api` 之前 → 接口返回 HTML；fallback 吃掉 `/health`（它在 `index.js` 里后注册，§1.24 同源坑）→ 健康检查变成一整页；`/uploads` 未命中回落 index.html → 「文件不存在」变 200 | 静态托管与 catch-all 的天然副作用 | fallback 显式排除 `api\|uploads\|socket\.io\|health`，且整段挂在 `/api` 路由与 `/api` JSON 404 **之后**；钉成 `scripts/static_host_check.mjs`（20 项，自包含隔离实例） | ✅ |
| TEST-4 | 低 | 测试流程 | 同一个 3001 出现两个 LISTENING（`0.0.0.0` 新实例 + `127.0.0.1` 旧实例）：Windows 下更具体的 `127.0.0.1` 优先，回环请求打到旧进程，验证出现**假失败**。根因是 `job_kill` 只杀 pwsh 包装，node 子进程存活（§1.13 复发） | 只信 `job_kill` 的返回，没确认端口真的空了 | 按 PID 核 `Get-CimInstance Win32_Process` 的 CommandLine/CreationTime 后 `Stop-Process`；收尾以 `netstat` 断言端口已释放 | ✅ |

## 10.3 本轮验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 后端主自检 | `cd server && node scripts/smoke_test.mjs` | **125 / 125**（原 121，+4：绑定 IP 记录 / 不一致 403 / 还原后可用 / 在线列表不含 username） |
| 实时 socket | `cd client && node ../server/scripts/socket_check.mjs` | **44 / 44** |
| 房间图标权限 | `cd server && node scripts/room_icon_check.mjs` | **41 / 41** |
| **安全控制回归（新增）** | `cd server && node scripts/security_check.mjs` | **29 / 29** |
| **单端口托管回归（新增）** | `cd client && npm run build && cd ../server && node scripts/static_host_check.mjs` | **20 / 20** |
| 前端构建 | `cd client && npx vite build` | 通过（112 模块，`dist/` 内 **0 个 `.map`**） |
| 局域网共享入口 | `cd client && npm run build` + `cd server && npm run start:lan` | 通过（21 项实测，见下表） |
| 前端 lint | `cd client && npm run lint` | **0 error** / 16 warning（与既有基线一致） |

`security_check.mjs` 是**自包含**的：自己在系统临时目录生成隔离配置 + 独立数据库，
自己拉起独立端口的实例，跑完杀掉并删干净 —— 不连 `chat.db`、不影响正在运行的服务。
定向证据（全部实测）：

| 验证内容 | 结果 |
| --- | --- |
| Vite dev server 默认绑定 | `netstat` 只有 `127.0.0.1:5173`；从局域网 IP 访问「无法连接」；`npm run dev:lan`（`VITE_DEV_HOST=0.0.0.0`）时才出现 `0.0.0.0:5173` 与 Network 行 |
| **局域网共享（后端单端口）21 项** | 后端绑 `0.0.0.0:3001` 并由它托管 `client/dist`：局域网 IP 可打开首页且**只引用打包后的 assets/css**；`logo.jpg` 等 `public/` 文件可访问；`/src/main.jsx`、`/src/App.jsx`、`/vite.config.js`、`/package.json`、`/package-lock.json`、`/node_modules/.vite/deps/_metadata.json`、`*.js.map` **全部不可下载**；`/api/v1/state` 仍是 **JSON 401**、未匹配 `/api/*` 仍是 **JSON 404**、**`/health` 仍是 JSON**（没被 SPA fallback 吞掉）；缺失的上传文件**不**回落成 index.html；任意前端路由回落 SPA 外壳；socket.io 轮询与 **WebSocket 升级**同源可用；`127.0.0.1:3001` 同样返回应用 |
| dev 模式的代价（对照） | `npm run dev:lan` 下 `GET http://192.168.1.4:5173/src/main.jsx` → **200 + 原始模块代码**，即 F-01 的泄露机制；单端口路径下同路径不可下载 |
| 前端产物 | `dist/` = index.html / css / js / logo.jpg，**没有** `.map` |
| 后端默认绑定 | `netstat` 只有 `127.0.0.1:3001`；`http://192.168.1.4:3001/health` 连接被拒；配置里删掉 host 行仍回落到 `127.0.0.1` |
| F-03 密钥 IP 绑定 | 回环申请、换真实 IP（`192.168.56.1`）使用 → **403**；反向（局域网申请、回环使用）→ **403**；同 IP → 200；伪造 `X-Forwarded-For: 8.8.8.8` 仍按 TCP 对端算（200，未被绕过） |
| F-03 存量密钥 | 把 `bound_ip` 置 NULL（模拟迁移前的密钥）→ 首个请求 200 且就地补写为当前 IP |
| F-04 账号维度 | 前 10 次错误密码 401 → 第 11 次 **429 + Retry-After**；另一个账号仍 401（非全局封锁）；成功登录后计数清零（再错 10 次仍 401） |
| F-04 IP 维度 | 3 个不同用户名的错误登录后，**第 4 个全新用户名**同样 429 |
| F-05 可见范围 | 陌生人 S 不在 P 的在线列表里；把 S 拉进同一个群（借共同好友 R 建群）后 S 可见；条目只有 `id/nickname/avatar`；`/api/v1/state` 的 `online` 同样受限；`scope: all` 开关有效 |
| 安全默认值 | `server.host` 缺省 = `127.0.0.1`；`presence.scope` 缺省 = `related` |

## 10.4 仍然保留的取舍 / 未修项

1. **JWT 有效期 7 天 + 令牌存 `localStorage`**（报告 F-04 附带提到）：报告建议缩短有效期、
   引入刷新令牌、改存 `HttpOnly; Secure; SameSite` Cookie。这属于**认证架构改造**
   （Cookie 方案还要配套 CSRF 防护与前端改造），本轮未动，保持现状 = 已知取舍。
   当前缓解：无 XSS（报告 §三 已验证）、`/api/v1` 只认密钥、登录限流已补。
2. **登录限流是进程内计数**：重启即清空（好处是锁定会自然解除，坏处是多实例部署时各算各的）。
   需要跨实例一致时应换成 Redis 等共享存储。
3. **`security.trust_proxy` 仍默认 `false`**：这是对的。单端口部署下后端直接面对客户端，**必须**保持 `false`（开了就能伪造 `X-Forwarded-For`）；只有「后端只听回环 + 前面挂 nginx/代理」时才该打开。单端口路径还有个附带好处：后端看到的就是真实客户端 IP，密钥 IP 绑定与登录限流因此**按设备**生效。
4. **`client.serve` 的取舍**：打开后后端对局域网提供页面与 API，需要 `npm run build` 才有产物（没有产物时只记一行日志并退回纯 API，不会崩）。若以后要区分「公开端口」，用 nginx 反代 + 只暴露 80。
5. 前一轮遗留的 §7（SEC-5 外链头像、LOG-1 日志级别、§8.4 索引与清理等）**未在本轮处理**。

---

# 第五轮：手机图片上传（用户反馈）

用户反馈：「当前不支持手机图片和更多图片类型」。先实测确认，再动手。

## 11.1 实测到的真实限制（不是猜测）

探针：`POST /api/avatar`、`/api/assets/upload`、`/api/file`，文件用手机常见格式。

| 格式 / 场景 | 头像 | 资源池 | 聊天附件 |
| --- | --- | --- | --- |
| 手机 JPEG / PNG / WebP | ✅ | ✅ | ✅ |
| **6MB 手机直出照片** | ❌ **头像不能超过 5MB** | ✅ | ✅ |
| **iPhone HEIC / HEIF** | ❌ 头像格式不支持 | ❌ 只支持 4 种 | ✅（但前端渲染不出来） |
| **AVIF** | ❌ | ❌ | ✅ |
| **BMP** | ✅ | ❌ | ✅ |
| **TIFF** | ❌ | ❌ | ✅ |

根因四条：

1. **体积**：手机直出 3–12MB，头像上限 5MB —— 一张自拍都传不上去，而且上传前**没有任何压缩**。
2. **方向**：手机照片靠 EXIF Orientation 标记方向；没有任何重编码流程去处理它。
3. **格式**：白名单只有 4 种，而且**两处不一致**（头像含 BMP、资源池不含）；HEIC 直接按扩展名拒。
4. **选择器**：三处 `<input accept="image/png,image/jpeg,image/gif,image/webp">` 把选择器限死，
   手机相册里的 HEIC 照片会被系统置灰/过滤，用户**根本选不到**。

> 顺带纠正报告：外部渗透报告 §三 写的「上传按**文件魔数**校验」**不成立** ——
> 服务端全程没有魔数校验（`grep magic|sniff` 无命中，依赖里也没有图片库），
> 实际判定依据是**扩展名 + MIME**。它的结论（.html/.svg 被拒）是对的，机制说错了。

## 11.2 修复

| 编号 | 级别 | 位置 | 修法 | 状态 |
| --- | --- | --- | --- | --- |
| IMG-1 | 高（手机直出照片传不上去） | 新增 `client/src/utils/image.js` | 上传前统一规范化：`createImageBitmap(file,{imageOrientation:'from-image'})` 解码（**按 EXIF 方向**）→ 等比限制长边 → 重编码（有透明留 PNG，否则 JPEG，逐轮降质/降尺寸收敛）。实测 10.90MB / 4000×3000 的直出照片 → **0.13MB / 1024×768** | ✅ |
| IMG-2 | 高（HEIC 传不了） | 同上 | 手机浏览器能解码 HEIC → 就地转 JPEG，**所以手机上传反而正常**；桌面浏览器解不开 → 抛 `ImagePrepareError/UNDECODABLE`，文案给出**可执行做法**（相册另存为 JPEG / 相机格式改「兼容性最佳」），不再是干巴巴一句「格式不支持」 | ✅ |
| IMG-3 | 中（选择器选不到照片） | `AssetLibraryModal` / `AppearanceModal` / `StickerPackManager`；新增 `IMAGE_ACCEPT` | `accept` 由写死的 4 个 MIME 改为 `image/*`，手机相册与拍照都能选中 | ✅ |
| IMG-4 | 中（白名单不一致且太窄） | `server/config.yaml`、`services/assets.js`、`middleware/upload.js` | 头像与资源池统一为 **PNG/JPG/JPEG/GIF/WebP/BMP/AVIF**；`services/assets.js` 的 `MIME_EXT` 同步补 bmp/avif；头像上限 5MB → **8MB**（客户端压到 3.5MB，这是服务端兜底） | ✅ |
| IMG-5 | 中（提示文案会再次漂移） | 同上 | 拒绝文案**从白名单现算**（`UNSUPPORTED_MSG` / `AVATAR_FORMAT_MSG` / `ASSET_FORMAT_MSG`），不再硬编码「只支持 PNG / JPG / GIF / WebP 图片」 | ✅ |
| IMG-6 | 低（前端前置校验过严） | `StickerPackManager.jsx` | 前置「单张 ≤10MB」改为「原图 ≤40MB」—— 压缩发生在之后，否则 12MB 的手机照片会在压缩前就被拦下 | ✅ |
| IMG-7 | 低（文案与实现不符） | `AvatarEditor` / `RoomIconEditor` / `PublicRoomIconModal` / `GroupInfoModal` / `AppearanceModal` / `AssetLibraryModal` | 统一改成「手机相册 / 拍照均可 · 大图自动压缩」，并列出真实支持的格式 | ✅ |
| IMG-8 | 低（格式判断漏新格式） | `utils/fileUtils.js`、`UploadProductModal.jsx`、`services/products.js` | 图片判定正则补 `bmp\|avif`（否则 AVIF 素材会被当成普通文件） | ✅ |

**有意不做的**：服务端**不收 HEIC/HEIF/TIFF**。桌面端 Chrome/Firefox/Edge 渲染不了它们，存进去就是裂图；
而「手机上能传」已由 IMG-2 的客户端转码解决。以后想改白名单，请先想清楚这一点。

## 11.3 本轮验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| **图片规范化（真浏览器）** | `cd server && node scripts/image_check.mjs` | **15 / 15**（无头 Edge 跑真实 `image.js`） |
| **上传格式白名单** | `cd server && node scripts/upload_format_check.mjs` | **25 / 25**（自包含隔离实例 + 临时库 + 临时上传目录） |
| 后端主自检 | `cd server && node scripts/smoke_test.mjs` | **125 / 125** |
| 实时 socket | `cd client && node ../server/scripts/socket_check.mjs` | **44 / 44** |
| 房间图标权限 | `cd server && node scripts/room_icon_check.mjs` | **41 / 41** |
| 安全控制 | `cd server && node scripts/security_check.mjs` | **29 / 29** |
| 单端口托管 | `cd server && node scripts/static_host_check.mjs` | **20 / 20** |
| 前端构建 / lint | `cd client && npm run build` / `npm run lint` | 通过 / **0 error / 16 warning**（基线不变） |

定向证据（全部实测）：

| 验证内容 | 结果 |
| --- | --- |
| 4000×3000 / **10.90MB** 直出 JPEG → 头像参数 | 输出 **1024×768 / 0.13MB**，转 JPEG，扩展名写回 `.jpg` |
| **EXIF Orientation=6** 的 400×200 图（maxDim 300） | 输出 **150×300（竖）**；不处理方向的话会是 300×150 横图 |
| 带透明的大 PNG | 仍输出 PNG（透明没被烤成白底） |
| 已达标的小图 / GIF / SVG / 非图片 | 原样返回（`out === in`），不重编码、不丢动画 |
| 解不开的 `.heic` | `ImagePrepareError`，`code=UNDECODABLE`，文案含「相册 / 相机」可执行指引 |
| 服务端格式矩阵 | 头像与资源池：PNG/JPG/JPEG/GIF/WebP/**BMP/AVIF** 收，**HEIC/HEIF/TIFF 拒**（文案列出真实清单）；6MB 直出照收；聊天附件仍不限类型 |
| 手机选择器 | 3 处 `accept` 已由写死 MIME 改为 `image/*`（代码核对 + 构建通过） |

## 11.4 遗留 / 取舍

1. **服务端不收 HEIC**（见 11.2 末尾说明）：有意为之，不是遗漏。若要收，必须同时做服务端转码
   （会引入 sharp/libvips 依赖），否则就是往库里塞裂图。
2. **压缩是有损的**（除带透明 PNG 外统一转 JPEG，质量 0.85 起）：头像 / 背景 / 表情 / 封面都是展示图，
   可以接受；**商品内容文件（`/api/shop/upload`）刻意不压缩** —— 那是交付物。
3. **GIF 不压缩**：canvas 重编码会丢动画，原样上传（超大 GIF 仍可能撞单文件上限）。
4. **超大图仍有解码成本**：一张 48MP 照片在手机上解码约几百毫秒，可接受；将来要再快可以挪进 Web Worker。

---

# 第六轮：附件预览与商品图集（用户需求）

用户需求原文：「添加视频 / 音频 支持内联播放，文档 / 压缩包 / 代码 / 其他显示卡片使用主流的真正的样式，
你可以从网上下载后使用，实现可预览（封面是图片，点开像京东一样支持文字描述，图片，视频等等）」。

## 12.1 先复核现状（动手前）

| 能力 | 改动前 |
| --- | --- |
| 视频 / 音频 | **完全没有内联播放**：`grep '<video\|<audio'` 零命中，一律是文件卡片 |
| 文件卡片图标 | 字母方块（`W`/`X`/`PDF`/`ZIP`/`♪`/`▶`/`{}`），两种实现并存（`getFileMeta` 与 `getShopFileIcon`） |
| 附件类型 | `/api/file` 只分 `image` / `file` 两类，视频音频都被当成普通文件 |
| 商品「预览」 | **服务端接口早已存在**（`GET /api/shop/preview/:pid/:fid`，只放行 `is_preview=1`），
但**前端从未调用**：卖家勾了「预览」只换来一行「· 可预览」文字，是个空壳 |
| 商品图集 | 只有一个封面 `<img>`，没有缩略图、没有多图、没有视频 |

## 12.2 本轮改动

| 编号 | 级别 | 位置 | 修法 | 状态 |
| --- | --- | --- | --- | --- |
| MEDIA-1 | 中 | `routes/user.js`、`chat/MessageBubble.jsx`、`chat/ChatInput.jsx` | 附件按 MIME 分类为 `image/video/audio/file`；视频用 `<video controls preload="metadata" playsInline>`（**不自动播放**）、音频用图标 + `<audio controls>`；`onError` 时**退回文件卡片**并提示「浏览器无法直接播放，下载后用本地播放器打开」（`avi/mkv/flac` 浏览器不保证能解） | ✅ |
| MEDIA-2 | 中 | 新增 `components/common/FileTypeIcon.jsx` | 11 类文件类型图标（word/excel/ppt/pdf/text/code/archive/audio/video/image/file）。品牌图形路径取自 **simple-icons（CC0-1.0）**，经 jsDelivr 取回后把 `<path d>` 内联 —— 零依赖、不在运行期请求网络；颜色沿用项目既有品牌色。同时导出纯函数 `fileKind(name, mime)` 供判类复用 | ✅ |
| MEDIA-3 | 低 | `utils/fileUtils.js`、`ProductDetailModal.jsx`、`ChatInput.jsx` | **删掉两套字母方块实现**（`getFileMeta` / `getShopFileIcon`），全部改用 SVG 图标；顺手把 `ChatInput` 里用 📎 emoji 当图标的地方也换掉（违反「禁用 emoji 当图标」的既有规则） | ✅ |
| MEDIA-4 | 中 | `components/shop/ProductDetailModal.jsx`、`components/common/MediaPreviewModal.jsx`（新增）、`api/shopApi.js` | **把「预览」真正接上**：`previewFileBlob()` 走鉴权取 Blob → objectURL；文件列表里勾了预览的文件出现「预览」按钮（**未购买也能点**），未购买时下载位仍显示「未购买」。预览浮层支持 图片 / 视频 / 音频 / PDF（iframe）/ 文本代码（`<pre>`，200KB 上限），其余类型明确提示下载 | ✅ |
| MEDIA-5 | 中 | 同上 | **京东式图集**：主图区 = 封面 + 勾了「预览」的图片/视频，下方缩略图条（选中高亮、视频带 CSS 播放角标），选中视频时主图位切换为 `<video>`。**不需要改库**：复用 `product_files.is_preview`。图片走鉴权 Blob，**视频点中才加载**（否则一进详情页就下整段视频） | ✅ |
| MEDIA-6 | 低 | `services/products.js` | 详情接口返回的 `isPreview` 由 SQLite 的 `0/1` **统一成布尔**（字段名是 `isPreview` 就该是 `true/false`，否则前端 `=== false` 会踩坑） | ✅ |

## 12.3 本轮验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 后端主自检 | `cd server && node scripts/smoke_test.mjs` | **135 / 135**（新增 4.5 节 10 项：附件分类 4 + 试看 6） |
| 实时 socket / 房间图标 / 安全 / 单端口 / 上传格式 / 图片规范化 | 见 §10.3、§11.3 | 44 / 41 / 29 / 20 / 25 / 15 全绿 |
| **UI 定向回归（临时，无头 Edge 渲染真实组件）** | `node tmp-media-check.mjs`（跑完已删） | **31 / 31** |
| 前端构建 / lint | `cd client && npm run build` / `npm run lint` | 通过（115 模块）/ **0 error / 16 warning**（基线不变） |

UI 回归覆盖的关键点（都在真浏览器里断言真实 DOM）：

| 验证内容 | 结果 |
| --- | --- |
| 视频消息 | 渲染 `<video.msg-video>`，有 `controls`、`preload=metadata`、无 `autoplay`、`playsInline` |
| 音频消息 | 渲染 `<audio.msg-audio-el>` 且有 `controls`，旁边是 SVG 类型图标 |
| 文件卡片 | 3 个非媒体附件走卡片，图标为内联 `<svg>`；xlsx/zip/pdf 的实际取色 = `rgb(33,115,70)`/`rgb(240,165,0)`/`rgb(227,62,51)`（即 #217346/#f0a500/#e33e33） |
| 无 emoji 图标 | 卡片区域不再出现 📎 |
| 播放失败回落 | 用浏览器解不了的视频 → 先渲染播放器，`onError` 后自动换成文件卡片并出现「无法直接播放」提示 |
| 商品图集 | 缩略图 = 封面 + 预览图 + 预览视频共 3 个；主图位显示图片；视频缩略图带播放角标；文案描述原样展示 |
| 试看按钮 | 只有勾了「预览」的 3 份文件有「预览」按钮；4 份文件都显示「未购买」；**下载按钮 0 个**（未购买） |
| 预览浮层 | 点「预览」弹出 `.pv-overlay`；文本文件渲染 `.pv-text` 且内容正确；视频文件用 `<video.pv-video>`；点遮罩可关闭 |
| 主图切换 | 点中视频缩略图后主图位变成 `<video>` |

> 顺带记两个 harness 的坑（下次直接用）：① HTML 内联 `<script type="module">` 里**不能写 JSX**
> —— Vite 会把内联脚本当纯 JS 解析并返回 **500**，必须拆成独立的 `.jsx` 文件；
> ② Chromium 现在会拦截**跨源访问回环地址**，页面与结果回收口必须同源（本次用一个同源反代把 Vite 包住）。

## 12.4 遗留 / 取舍

1. **不做服务端转码**（**已于第九轮做掉，见 §15**）：当时视频一律原样存原样播，「播不了就退回卡片」；
   要「任何格式都能播」得上 ffmpeg 转码，属基础设施级改动 —— 现在本机 ffmpeg 就位，`services/transcode.js`
   会产出可播副本（原件不动），前端自动切换。
2. **Office 文档（doc/xls/ppt）不能在线预览**：浏览器没有渲染器，也未接 Office Online 之类的第三方服务
   （会把文件交给外网，不适合本项目的局域网定位）。预览浮层会明确提示下载。
3. **图集顺序 = 封面 + 文件排序**：没有做「拖拽排序 / 主图选择」，卖家通过调整文件顺序间接控制。
4. **文本预览上限 200 KB**：超出只显示前 200 KB 并提示下载，避免把大日志读进内存卡死页面。

---

# 第七轮：撤回改为「直接删除」

用户要求：撤回后**不显示**「⚠️ 消息已撤回」，直接从会话里消失。

## 13.1 改动

| 编号 | 级别 | 位置 | 改动前 | 改动后 | 状态 |
| --- | --- | --- | --- | --- | --- |
| RECALL-1 | 低 | `services/chat.js::recallMessage` | `UPDATE messages SET text='[消息已撤回]'`，留一条占位行 | **DELETE 这条消息 + 它的已读回执**，然后照常广播 `message:recalled` 让其他客户端把它从列表里移除 | ✅ |
| RECALL-2 | 低 | `chat/ChatRoom.jsx` | 收到 `message:recalled` 把本地那条的 text 改成占位文案 | 直接从列表 `filter` 掉 | ✅ |
| RECALL-3 | 低 | `chat/MessageBubble.jsx`、`styles/index.css`、`ChatRoom.buildMenuItems` | 有 `isRecalled` 分支渲染「⚠️ 消息已撤回」，还有 `.message.recalled` 灰化样式与「撤回消息不弹右键菜单」的特判 | **全部删除**（撤回后这条根本不存在了，这些分支是死代码） | ✅ |
| RECALL-4 | 中 | `db/schema.js` | — | **一次性数据清理**：老库里的 `[消息已撤回]` 占位行会被当成普通文本原样显示，所以启动时连同其已读回执一起删掉（幂等，清完即静默） | ✅ |

> RECALL-4 是这次改动**必须配套**的一步：占位渲染一旦移除，历史占位行就会以 `[消息已撤回]` 的原始文本出现在聊天里。
> 实测确认过：改完前端后跑 `socket_check`，历史里确实还能查到旧的占位行（前几轮测试与真人使用留下的），
> 加迁移后重启即清掉（启动日志 `[db] 清理 1 条历史「消息已撤回」占位行`）。

## 13.2 验证

| 验证项 | 结果 |
| --- | --- |
| `socket_check`（新增 2 条断言） | **46 / 46**：撤回后历史里**查不到**这条消息；历史里**不存在** `[消息已撤回]` 占位行 |
| 其余套件 | `smoke_test` 135 / `room_icon_check` 41 / `security_check` 29 / `static_host_check` 20 / `upload_format_check` 25 / `image_check` 15 全绿 |
| 前端构建 / lint | 通过 / **0 error / 16 warning**（基线不变） |
| 迁移幂等性 | 重启第二次不再打印清理日志（查不到即不写） |
| 数据现状 | `chat.db` 中 `[消息已撤回]` 行数 = **0** |

## 13.3 语义说明

撤回窗口（`business.message.recall_window_ms`，默认 2 分钟）与「只有发送者本人能撤回」的校验**都没变**，
变的只是撤回后的结果：从「留一条灰掉的占位」变成「这条消息不存在」——列表里不再留任何痕迹。

---

# 第八轮：文件类型封面（开发者可新增类型 + 配封面）

用户需求：「添加支持开发者手动为新增类型添加封面」（确认过：指**文件类型**，不是商品分类）。

## 14.1 背景

上一轮（§12）加了 11 类文件类型图标，但**类型表是硬编码在 `FileTypeIcon.jsx` 里的**：
开发者遇到内置列表外的类型（`.psd` / `.apk` / `.dwg`…）只能改组件源码、手搓 SVG 路径、再重新构建前端。
这一轮把它变成**数据驱动 + 开发者可配封面**。

## 14.2 改动

| 编号 | 级别 | 位置 | 修法 | 状态 |
| --- | --- | --- | --- | --- |
| FTYPE-1 | 中 | `config.yaml`（新增 `files.types`）、`config.js` | 开发者在这里新增/覆盖类型：`key / label / color / exts / cover`。启动时校验并规范化（key 只允许小写字母数字`_-`、扩展名统一小写补点、颜色必须是十六进制、封面走 `normalizeImageUrl`）；**非法条目只警告并跳过，绝不让整个后端起不来**（对齐 §1.25 的教训） | ✅ |
| FTYPE-2 | 中 | 新增 `routes/fileTypes.js` | `GET /api/file-types`（需登录）下发开发者配置的类型。走接口而不是塞进构建产物 → **改配置重启后端即生效，不用重新 `npm run build` 前端** | ✅ |
| FTYPE-3 | 中 | 新增 `client/src/utils/fileTypes.js` | 类型注册表成为**唯一真相**：内置 11 类 + 后端下发的自定义类型（**自定义优先**，同 key 可覆盖内置的颜色/封面；同扩展名以自定义为准）。为此把 `fileKind()` 从 `FileTypeIcon.jsx` 搬到 utils —— 顺带**去掉了之前为绕开 `react-refresh/only-export-components` 而加的 eslint-disable** | ✅ |
| FTYPE-4 | 中 | `FileTypeIcon.jsx`、`App.jsx` | 类型带 `cover` 时直接渲染封面图 `<img>`（`width/height` 属性 + 样式都给，避免布局抖动），否则用内置 SVG。注册表是异步拉取的，用 `useSyncExternalStore` 订阅 → **已经渲染在屏幕上的图标也会自动重画**；`App` 登录后拉一次（同一会话有缓存），登出时 `resetFileTypes()` 防止换账号串数据 | ✅ |

### 开发者怎么用

```yaml
# server/config.yaml（或 config.local.yaml，后者不入库）
files:
  types:
    - key: psd
      label: PSD
      color: '#31a8ff'
      exts: ['.psd', '.psb']
      cover: '/uploads/covers/psd.png'   # 封面图：用任意账号上传图片后把返回的 /uploads/... 填这里
    - key: apk
      exts: ['.apk', '.aab']             # 不写 cover / label / color 也都能跑
    - key: video                          # key 与内置同名 → 覆盖内置类型
      exts: ['.mp4', '.mov']
      cover: '/uploads/covers/video.png'
```

改完 **重启后端**即可（前端不用重新构建）。封面也支持 `http(s)` 外链与 `data:image/`。

## 14.3 本轮验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| **文件类型表（新增，自包含）** | `cd server && node scripts/file_types_check.mjs` | **15 / 15** |
| 其余套件 | 见 §10.3 / §11.3 / §12.3 / §13.2 | `smoke_test` 135 / `socket_check` 46 / `room_icon_check` 41 / `security_check` 29 / `static_host_check` 20 / `upload_format_check` 25 / `image_check` 15 全绿 |
| **前端合并与渲染（临时，无头 Edge）** | `node tmp-ft-check.mjs`（跑完已删） | **21 / 21** |
| 前端构建 / lint | `npm run build` / `npm run lint` | 通过 / **0 error / 16 warning**（且少了一个 eslint-disable） |

`file_types_check.mjs`（自包含：临时配置 + 临时库 + 隔离端口）覆盖：

| 验证内容 | 结果 |
| --- | --- |
| 配置里混入 4 条非法条目 | 服务**照常启动**，每条都有明确警告（key 非法 / 无扩展名 / key 重复 / 封面 scheme 不支持 / 非对象） |
| 鉴权 | 未登录 `GET /api/file-types` → **401** |
| 规范化 | `.PSD`/`psb` → `.psd`/`.psb`；`label` 缺省用 key **大写**；颜色非法回落 `#64748b`；站内与 https 封面都保留；`javascript:` 封面被丢弃但**条目本身保留** |
| 只下发合法项 | 8 条配置 → 只返回 4 条合法类型 |

前端 harness 覆盖（真浏览器、真 DOM）：

| 验证内容 | 结果 |
| --- | --- |
| 拉取前 | 未知扩展名回落 `file`；内置 `video` 用内置色 |
| 拉取后 | `.psd` → 渲染成 `<img src="/uploads/covers/psd.png">` 且按 `size` 设了宽高属性；`.mp4` 改用自定义封面 |
| 已渲染图标自动重画 | 先渲染出 SVG，`applyCustomTypes()` 之后**同一批 DOM 变成 `<img>` 封面**（`useSyncExternalStore` 那条链路） |
| 边界 | 扩展名大小写不敏感、多扩展名都命中、无 `cover` 走 SVG 且用自定义色、内置类型不受影响、未知类型仍灰色兜底、`javascript:` 封面被过滤 |
| 真实拉取链路 | `loadFileTypes()` 打到 `/api/file-types`、带上 `Bearer` 头、拉到即生效、**同一会话只请求一次** |

端到端（真实实例 + 真实账号）：临时写一个 `config.local.yaml` → 重启 → `GET /api/file-types` 返回该类型（含封面）、未登录 401 → 删除临时配置。

## 14.4 遗留 / 取舍

1. **没有做管理后台 UI**：本轮是「改 `config.yaml` + 重启」的开发者路径（用户已确认要这个）。
   如果以后要在网页里增删类型、上传封面，服务端接口与前端注册表都已经就位，只差一个管理页签。
2. **封面图要自己上传拿地址**：复用了现有的图片上传（`/api/avatar` 或 `/api/assets/upload`），
   没有做「在配置里直接传图」——配置文件里放 base64 不现实。
3. **自定义类型不参与上传白名单**：这里只管**显示**（图标/封面）。某个扩展名能不能上传，
   仍由 `uploads.avatar.allowed_ext` / `business.assets.allowed_ext` / 聊天附件（不限类型）决定 ——
   两件事分开是有意的：显示层不该悄悄放宽上传面。

---

# 第九轮：本地 ffmpeg 转码（任何格式都能播）

用户要求：**本地有 ffmpeg，添加任何格式都能播放**。
上一轮把「不做服务端转码」写进了遗留清单（§12.4 第 1 条），本轮把它做掉。

## 15.1 设计决策（为什么这么切）

| 决策 | 理由 |
| --- | --- |
| **只产副本，永不改原件** | 下载 / 商品交付拿到的必须还是上传的那份字节。转码只服务「在线播放」，不是「替换文件」 |
| **副本地址由源文件名确定性推导**：`uploads/<子目录>/tc/<同名>.mp4\|.m4a\|.mp3` | **不改库、不改协议**：历史消息、其他客户端、REST / 密钥通道一行都不用动。任何一端问一句 `/api/media/status` 就知道「该播哪个地址、转好了没」 |
| **ffprobe 同步判「要不要转」（几十毫秒，带缓存），ffmpeg 走后台队列** | 上传请求不能被几十分钟的转码卡住。`describe()` 幂等：重复问复用同一个任务 |
| **判「能不能播」= 容器 + 编码双看（ffprobe），不看扩展名** | 只看扩展名会漏掉「`.mp4` 里装 HEVC」；只看编码会漏掉「`.mkv` 里装 h264」（容器不支持）。两个反例都进了回归 |
| **编码已浏览器友好、只是容器不对 → 只换壳**（`-c copy -movflags +faststart`） | mkv/avi 里装 h264+aac 是**秒级**完成，不必重编码；换壳失败自动退回全量转码 |
| **输出先写 `*.part`，成功后 `rename` 原子落位** | 静态目录里绝不能出现半截 mp4 —— 浏览器会拿到一个「播到一半戛然而止」的文件，比播不了更糟 |
| **ffmpeg 缺失 → 一条警告 + 降级成旧行为** | 「没装 ffmpeg」不该变成上传失败，也不该刷屏报错 |
| **客户端「播不了先问 status」，不直接退回卡片** | 服务端可能早就转好了、或者正在转；直接退回卡片等于白做 |

## 15.2 落地清单

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| TRANS-1 | 高 | `server/src/services/transcode.js`（新增）、`routes/user.js`、`routes/media.js`（新增） | 视频/音频只有「原样播」，mkv/avi/flv/wmv/rmvb/wma 一律退回文件卡片让用户自己下载播 | 前一轮明确「不做服务端转码」（§12.4） | 新增转码服务：ffprobe 探测 → 计划（`none`/`remux`/`transcode`）→ 后台队列 ffmpeg → 副本落 `uploads/files/tc/`；`POST /api/user/file` 当场回 `playback` 计划；`GET /api/media/status?src=` 供轮询/自愈 | ✅ |
| TRANS-2 | 中 | `server/src/services/transcode.js::ffmpegArgs` | **实测踩到**：转码任务全部失败，`ffmpeg 退出码 4294967274：Error opening output files: Invalid argument` | ffmpeg 按**输出文件的扩展名**推断封装格式，而原子落位要求先写 `*.part`（未知扩展名 → 无可用封装器） | 显式 `-f mp4` / `-f mp3`（`m4a` 也用 `-f mp4`，别去猜 `ipod`）。`.part` 同时保证半成品不会被当成视频加载 | ✅ |
| TRANS-3 | 中 | `transcode.js` 的 `videoIsNative()` / `audioIsNative()` | 若按扩展名判「能不能播」，`.mp4` 装 HEVC、`.webm` 装 vp9+opus 这两种会被判反 | 浏览器认的是**容器 + 编码**的组合，不是文件名 | 判定输入来自 ffprobe 的 `codec_name`：mp4/mov 里只认 h264(+aac/mp3)、webm 里只认 vp8/vp9/av1(+opus/vorbis)、音频按 mp3/m4a/ogg/flac/wav 分别判。两个反例都写成断言 | ✅ |
| TRANS-4 | 中 | `server/src/services/transcode.js` | 一个文件被多个客户端同时问、或轮询期间重复问，会重复转码 | 无任务去重 | 队列以**输出路径**为键（`jobs` Map）+ 磁盘上副本存在即 `ready`，天然幂等；失败记 `failures` 避免轮询反复重试 | ✅ |
| TRANS-5 | 中 | `server/src/routes/media.js` | 转码功能上线**之前**的老附件没人转，历史消息里的 mkv 依然播不了 | 转码只在「上传那一刻」入队 | `GET /api/media/status` 查到「该转但没人转」时就地入队：老附件、后端重启丢掉的任务，都在第一次被播放时自愈（回归里专门造了一个从未经上传接口的老附件） | ✅ |
| TRANS-6 | 中 | `server/src/routes/media.js` | 状态查询口可能被用来探测任意文件 | 直接拼路径 | 只受理 `/uploads/files/` 下的**单层文件名**（正则不含分隔符 + 显式拒 `..`），解析后再次确认在 `FILE_DIR` 内；`uploads/shop` 不走这里（付费交付物，走试看鉴权通道）。四种越界/非法输入都进了断言 | ✅ |
| TRANS-7 | 中 | `server/src/services/transcode.js`、`config.yaml → media.transcode` | 转码会吃满 CPU；大文件能跑很久；ffmpeg 卡死会占住队列 | 无任何闸门 | 并发 2、单文件超时 30 分钟（到点 kill + 清 `.part` + 记失败）、队列上限 50（满了让客户端下一轮再问，不做无界排队）、可选 `max_source_bytes` | ✅ |
| TRANS-8 | 中 | `server/src/routes/download.js::/shop/preview` | 卖家上架的 mkv/avi 商品视频，试看同样是「下载了才能看」 | 预览通道只 `sendFile` 原件 | `?playback=1` 返回可播副本：`200` 直接给（支持 Range，能拖进度条）、`202` + 进度表示还在转、`409` 转码失败。**下载通道 `?` 无关，交付的永远是原件**（断言逐字节比对） | ✅ |
| TRANS-9 | 低 | `client/src/components/chat/MessageBubble.jsx` | 「播不了就退回卡片」会让**正在转码**的附件显示成「浏览器无法直接播放」，误导用户 | 回退是本地 `onError` 驱动的，客户端不知道服务端能不能转 | 加播放状态机 `direct → waiting → play / fallback`：扩展名明显播不了的（mkv/avi/wma…）直接进 `waiting`，其余先试播、`onError` 再问；`waiting` 显示转码进度条（拿不到时长走不确定态动画），转好自动换成播放器；`stalled` 后给「继续等待」 | ✅ |
| TRANS-10 | 低 | `client/src/components/shop/ProductDetailModal.jsx`、`common/MediaPreviewModal.jsx` | 商品图集/试看弹窗里的视频同样只有「原件」一条路 | 同上 | 视频/音频改走 `?playback=1`：`202` 时在加载态里显示「源格式浏览器播不了，服务器正在转码 42%…」并轮询；试看弹窗与图集共用同一条链路 | ✅ |
| TRANS-11 | 低 | `server/scripts/transcode_check.mjs` | 回归脚本第一次跑出 10 条假失败 | 断言里的可播地址按**测试素材名**推导，而上传会被服务端重命名 | 断言按服务端返回的 `url` 推导副本名（顺带发现：`native.*` 那几条「没有多余副本」的断言原本是空转的） | ✅ |

## 15.3 本轮验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| **转码回归（新增，自包含）** | `cd server && node scripts/transcode_check.mjs` | **137 / 137** |
| **UI 定向回归（临时，无头 Edge 渲染真实 `MessageBubble`）** | `node scripts/tmp_media_ui_check.mjs`（跑完已删） | **17 / 17** |
| 后端主自检 / 实时 socket / 房间图标 / 安全 / 单端口 / 上传格式 / 图片规范化 / 文件类型 | 见 §10.3 / §11.3 / §12.3 / §13.2 / §14.3 | `smoke_test` 139 / `socket_check` 46 / `room_icon_check` 41 / `security_check` 29 / `static_host_check` 20 / `upload_format_check` 25 / `image_check` 15 / `file_types_check` 15 全绿 |
| 前端构建 / lint | `cd client && npm run build` / `npm run lint` | 通过（117 模块）/ **0 error / 16 warning**（基线不变） |

`transcode_check.mjs` 自包含（临时配置 + 临时空库 + 临时上传目录 + 隔离端口），
用**本机 ffmpeg** 现场生成测试素材（1 秒 160×120），逐个钉住：

| 素材 | 期望 | 验证内容 |
| --- | --- | --- |
| `native.mp4`（h264+aac） | **不转** | 上传响应 `needed:false` / `not_needed`；`tc/` 里不产生任何副本 |
| `native.webm`（vp8+vorbis） | 不转 | 容器+编码都合法 → 不误伤 |
| `native.mp3` / `native.flac` | 不转 | 纯音频白名单（flac 浏览器能播，别多转一份） |
| `remux.mkv`（h264+aac 装 mkv） | 换壳 | 计划 `remux`；副本是 mp4 且视频= h264、音频= aac |
| `old.avi`（mpeg4+mp3） | 转码 | 副本 h264/aac |
| `sound.wma`（wmav2） | 转码 | 副本 **mp3 且无视频流** |
| `hevc.mp4`（HEVC 装 mp4） | 转码 | **扩展名陷阱**：扩展名合法、编码不合法，必须转 |
| `fake.mp4`（文本冒充） | 放行 | ffprobe 认不出 → `needed:false`，不报错、不进队列 |

每条还断言：原件**逐字节未被改动**、原件地址仍可下载、副本地址 HTTP 200 且带 `Content-Length`、
`Range` 请求返回 **206**（能拖进度条）、重复查询仍然 `ready`（不重复转码）、跑完整轮 `tc/` 里**没有 `.part` 残留**。

另有三组：

| 场景 | 验证内容 |
| --- | --- |
| **前端播放状态机（纯函数）** | 12 项：`utils/mediaPlayback.js` 的 `initialMedia` / `nextMediaState` 在 9 种输入下的迁移 —— mkv/wma 直接进等待态、mp4 先原样试播、非媒体与表情不参与、pending 带进度、ready 切副本、failed 退卡片并说明原因、「服务端说不用转 + 原地址已失败」才退卡片、查询失败保持等待、迁移不丢 `stalled`/`retryNonce` |
| **历史附件自愈** | 直接往 `uploads/files/` 丢一个从没经过上传接口的 mkv → 第一次 `status` 查询即入队并转成可播 h264 |
| **商城试看** | 临时提权后上传商品视频（回带转码计划）→ 上架 → `?playback=1` 首次 `202`+进度、轮询到 `200` 且副本**不是**源文件；不带参数的预览通道与 `/shop/download` 给的仍是**逐字节相同**的原件 |

UI 定向回归（临时脚本：隔离后端 + Vite 转 JSX + 同源反代包住两者 + 无头 Edge，
按 §1.61 的两条硬规则搭的）在**真浏览器**里渲染真实 `MessageBubble`：

| 验证内容 | 结果 |
| --- | --- |
| 原生 mp4 | 直接渲染 `<video>`、`src` 就是原地址、不出现转码占位、`videoWidth > 0`（真解出画面） |
| avi（懒入队，挂载后才开始转） | 一上来是转码占位、占位期间无播放器、文案里写着「转码」、转完**自动**换成 `<video src=.../tc/xxx.mp4>`、占位消失、`videoWidth > 0` |
| 假 mp4（文本冒充） | 播放失败 → 问后端 → 后端说不用转 → 退回文件卡片并给出原因，坏播放器被移除 |
| wma 音频 | 先进转码占位 → 换成 `<audio src=.../tc/xxx.mp3>`，且不会渲染成视频元素 |

> 两次「假失败」都是**断言时机**问题而非产品问题：转码/失败切换发生在几十毫秒内，
> 断言却等了 500ms 才看 DOM，中间态早没了。修法是把采样起点压到挂载后 150ms，
> 并让「等待期是否出现过占位/进度」由轮询循环自己记录（`waitFor` 顺带采样）。

安全边界：未登录 `status` → 401；`..` 穿越 → 400；`avatars/` 等非 `files` 目录 → 400；
副本子目录不可被查询 → 400；不存在的附件 → 404。

## 15.4 遗留 / 取舍

1. **副本占磁盘**：转码后同一份内容存两份（原件 + 可播副本）。没有自动清理策略 ——
   附件本来就与消息同生命周期（撤回才删消息，文件不删），沿用现状；要清理得先有「附件回收」这件更大的事。
2. **转码是 CPU 密集操作**：并发默认 2、单文件 30 分钟上限、队列 50。没有优先级、没有暂停/取消接口，
   也不做「按需转 vs 全部预转」的取舍 —— 现在是**上传即入队**（用户马上要发，等不起），删了消息也不会撤销任务。
3. **不做历史批量预转**：老附件靠「第一次被播放时自愈」（TRANS-5），不会在启动时把整库扫一遍。
4. **ffmpeg 需要单独安装**：`config.yaml → media.transcode.ffmpeg/ffprobe` 可写绝对路径，
   默认从 PATH 找。容器/绿色部署要自己把 ffmpeg 带上；没装时功能整体降级（不报错）。
5. **Office 文档仍不能在线预览**：浏览器没有渲染器，转码救不了（转成 PDF/图片是另一件事，未做）。
6. **没有做「选择清晰度 / 只转音频」**：一律 h264+aac（视频）/ mp3（音频）。
7. **副本名只按 basename 推导**：同一目录下「同名不同扩展名」的两个源文件（`x.avi` + `x.mkv`，都要转 mp4）
   会互相顶掉。上传接口按 `{时间戳}_{随机}{扩展名}` 命名，天然不会撞；真要支持手工放进去的同名文件，
   把源扩展名编进副本名（`x.avi.mp4`）即可 —— 客户端不受影响（播放地址始终由服务端下发）。
8. **探测认得、但没有可解码帧的畸形文件**（典型：把 1×1 PNG 改名成 `.mp4`，`smoke_test` 的上传用例就是）
   会尝试一次转码并失败：日志里出现 `[transcode] 失败` 属**预期**，客户端与旧版一样退回文件卡片；
   失败会记入 `failures`，同一进程内不反复重试。不要为此加「体积太小就不转」这类特判（§1.71）。

---

# 16 第九轮收尾：测试残留清理 + 清理工具加固

用户指出「删掉冒烟测试数据」—— 也确实该删：本轮为了回归，我跑了 `smoke_test`（两次）、
`socket_check`、`room_icon_check`，全都打在**真实 `chat.db`** 上。

## 16.1 残留清单（实测）

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| 测试账号 | **11 个**（id 208–218） | `sm_6960426_*`（12:49 那轮）、`sk_*`、`ric_*`、`sm_7430281_*`（12:57 那轮）；真实账号只有 1/2/3/167 |
| 账号关联数据 | 消息 7 / 群 3 / 商品 12 / 订单 8 / 资源 24 / 积分流水 27 / 表情包 4 / 密钥 5 … | 由 `cleanup_test_data.mjs` 按账号一次性清掉 |
| 磁盘文件 | **64 个无引用文件** | 账号名下的 42 个（工具直接删）+ 22 个「没挂到任何行上」的：smoke 用例的 84 字节 PNG-冒充-mp4/mp3/png/txt、`uploads/tmp/*` 里上传中途放弃的临时图、已删测试账号 67/68/69/168/169 遗留的头像与资源池文件 |

清理后：账号回到 4 个真实账号，`uploads/` 只剩 11 个文件且**全部有库内引用**，`PRAGMA integrity_check = ok`。

## 16.2 自己踩的坑（已修）

删「无引用文件」时我把 **`room_settings.icon` 漏出了引用面** —— 公共聊天图标指向
`/uploads/avatars/avatar_2_1790399842520.jpg`（用户 2 的头像，`room_icon_check` 测完已正确还原该值），
于是这个「看起来没人引用」的文件被删掉，公共聊天图标变成裂图。
同一次扫描还漏了 `user_preferences.background`、`bubble` 主题 JSON、`groups.avatar`
这类**藏在文本/JSON 里的路径**。所幸已删清单里没有真实用户命中的项，只有这一个；
该文件已按同尺寸的同名头像副本恢复（`avatar_2_1790399365936.jpg`，49,958 B → 同一账号同一张图），
启动实测 `GET /uploads/avatars/avatar_2_1790399842520.jpg` → **200 / 49958 B / image/jpeg**。

**教训（已进 DEVLOG §2 规则）**：涉及「删文件」的工具，引用面必须**穷举**且**动态**地取
（遍历 `sqlite_master` 里的所有表、把每行 JSON 里的 `/uploads/` 路径全抠出来），
手工列字段一定会漏。

## 16.3 改动

| 编号 | 位置 | 改动 |
| --- | --- | --- |
| CLEAN-1 | `scripts/cleanup_test_data.mjs` | 补收集 `groups.avatar`、`user_preferences.background/bubble`（JSON 里的路径）、`room_preferences.background` |
| CLEAN-2 | `scripts/cleanup_test_data.mjs` | **删文件前再查一遍全库引用**（动态遍历所有表），仍被引用的文件**一律保留**并打印原因 —— 公共图标指向某账号头像这类情况从此不会再被删坏 |
| CLEAN-3 | `scripts/cleanup_orphan_files.mjs`（新增） | 孤儿文件清理：动态穷举引用面，删掉 `uploads/` 里没有任何库内引用的文件；**默认只演练**，`--apply` 才删，删除前复查引用，不动 `.gitkeep`，顺带清空空目录。命令：`npm run cleanup:orphans` |
| CLEAN-4 | `scripts/lib/cleanup_accounts.mjs`（新增）+ `smoke_test` / `socket_check` / `room_icon_check` | **根治 TEST-1**：三套自检跑完自动收尾 —— ① 复用 `cleanup_test_data.mjs` 删掉本套账号（含名下数据与上传文件）；② 按「跑之前的 `uploads/` 快照」只清**本次新产生且无人引用**的上传文件（不碰使用者自己「传了没发出去」的历史残留）；③ `--keep` 保留现场，并打印事后手动清理的命令；④ 收尾失败不影响测试结论，只提示手动命令 |

## 16.4 本轮验证

| 验证项 | 结果 |
| --- | --- |
| 全库引用审计（独立脚本遍历所有表 + 逐行 JSON） | 12 个引用里 11 个文件在盘上；唯一缺失的 `product_files#73`（`shop/1790345262208_u71igf.png`）**早于本次清理就已缺失**，属历史残留 |
| 启动实测 | `/health` ok、SPA 200、未登录 `/api/file-types` 401、恢复的公共图标 200 / 49958 B / image/jpeg |
| 三套自检**带自动收尾**重跑 | `smoke_test` **135 / 135**（删账号 230–232 + 清无主上传 5 个）、`room_icon_check` **41 / 41**（删 233–235）、`socket_check` **46 / 46**（删 236–237） |
| 重跑后残留复查 | 「没有匹配到任何账号」；孤儿文件 **0 个**；`uploads/` 11 个文件 / 12 个引用；`users=4`（真实账号）/ `messages=2` / `integrity_check = ok` |
| `--keep` | 实测有效：`room_icon_check --keep` 保留账号 227–229 并打印事后清理命令 |

## 16.5 仍然待办

1. `product_files#73` 指向一个本来就不存在的文件（历史残留行），不影响功能；
   需要的话可以顺手清掉这行。
2. `uploads/tmp` 没有定期清理 —— 本次是用 `cleanup_orphans` 兜的；
   要长期干净得给资源池上传加「失败即删临时文件」或加定时清理。
3. 自检脚本现在**默认会删自己的账号**：想事后翻数据库排查，记得加 `--keep`。

---

# 17 商城图片的「顺手另存」防护（试看图 + 首页卡片封面 + 开发者快捷键）

用户要求（两轮）：**防止用户通过右键在商城里下载预览的图像**；随后补充
**商城首页卡片里的图片也能被右键下载，这是不对的，同时禁用 F12**。

## 17.1 现状与威胁（先摆清楚）

试看的语义是「登录即可看、买后才能下载」（§1.60），所以**试看响应本身就是一条取文件的通道**；
首页卡片用的是商品封面（`/uploads/covers/...`，**静态公开**）。把「能拦的」和「拦不住的」分开列：

| 出路 | 能否用前端拦住 | 备注 |
| --- | --- | --- |
| 右键「图片另存为」/ 手机长按「存储图像」 | ✅ 能 | **全站默认菜单已禁用**（PROT-9），输入框除外；图片另有 `ProtectedImage` |
| 把图拖到桌面 / 拖进别的窗口 | ✅ 能（`draggable=false` + `user-drag:none` + 透明盾） | 试看图 / 详情页 / 卡片封面 |
| 按 F12 / Ctrl+Shift+I / Ctrl+U 开工具 | ⚠️ 只能说「按不出来」 | 浏览器菜单「更多工具 → 开发者工具」照样能开（PROT-8） |
| 开发者工具 → Network / Elements，或直接读 `blob:` | ❌ 拦不住（那是浏览器自己的界面） | — |
| 拿 token 直接 `GET /api/shop/preview/...`（curl / 脚本） | ❌ 前端完全管不着 | → **只能服务端限流**（PROT-3） |
| 直接访问 `/uploads/covers/xxx.png`（**连登录都不需要**） | ❌ 完全拦不住 | 卡片封面属静态公开目录（见 §17.4 第 1 条） |

结论：**「防止右键」能做到，但「防止下载」做不到**。真正决定「能拿走什么」的是服务端给的是什么、
以及它放在哪（静态公开目录 = 谁都能拿），而不是前端拦了什么。

## 17.2 改动

| 编号 | 级别 | 位置 | 改动 |
| --- | --- | --- | --- |
| PROT-1 | 中 | `client/src/components/common/ProtectedImage.jsx`（新增） | 受保护图片统一用它渲染：容器与 `<img>` 上都 `onContextMenu`/`onDragStart` 里 `preventDefault`，`draggable={false}`，`user-select:none` / `-webkit-user-drag:none` / `-webkit-touch-callout:none`，并在图上盖一层**透明盾**（`pointer-events:none` 的图片 + 盾承接事件，右键/拖拽都跑不掉）。组件顶部写明「这不是安全边界」 |
| PROT-2 | 中 | `common/MediaPreviewModal.jsx`、`shop/ProductDetailModal.jsx` | 试看浮层的图片、详情页图集主图与缩略图改走 `ProtectedImage`；试看的**视频 / 音频**也拦掉右键（「视频另存为」），原生控制条不受影响 |
| PROT-3 | 中 | `server/src/routes/download.js` | 试看接口加**独立限流**（按用户滑动窗口，`rate_limits.preview`，默认 60 次/分钟）。挡的是「写脚本把一个商品勾了试看的素材成批扒下来」—— 这是前端唯一管不到、也最现实的那条路 |
| PROT-4 | 低 | `server/src/routes/download.js` | 试看与下载的响应统一加 `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`：不在浏览器缓存里留一份可离线打开的副本，也不按别的类型解析 |
| PROT-5 | 低 | `config.yaml` / `config.js` | 新增 `rate_limits.preview`（与 `download` **分开计数**：逛详情页会一次拉好几张预览图，混在一起会把正常下载顶掉）；漏写有代码兜底 60/分钟 |
| PROT-6 | 低 | `scripts/cleanup_orphan_files.mjs` | 顺手补的**熔断**：默认跳过最近 60 分钟内改动过的文件。原因是清理时发现使用者**正在用这个应用**——一个刚传进 `uploads/files` 还没发送的 webp 从库里看就是「无引用」，差点被当垃圾删掉（`--min-age-minutes=0` 可关掉该保护） |
| PROT-7 | 中 | `client/src/components/shop/ProductCard.jsx` + `styles/shop.css` | **商城首页卡片封面**改走 `ProtectedImage`（右键 / 拖拽 / 长按全拦），并让外层占满 `.product-cover`（内部 `img` 的 100% 才有确定基准）。卡片整块的 `onClick` 不受影响（盾不吃冒泡，已用真浏览器断言过） |
| PROT-8 | 中 | `client/src/utils/captureGuards.js`（新增）+ `main.jsx` | **键盘守卫**：捕获阶段拦 F12 / Ctrl(⌘)+Shift+I·J·C / Ctrl+U（查看源码）/ Ctrl+S（保存页面）。**只在生产构建里安装**（`import.meta.env.DEV` 下不装，开发时照样能开 F12），并留了逃生口：URL 带 `?dev=1` 即跳过 |
| PROT-9 | 中 | `client/src/utils/captureGuards.js` + `main.jsx` | **全站禁用浏览器默认右键菜单**（用户追问「为什么不直接全禁」后补上）。两个要点：① **只 `preventDefault`、绝不 `stopPropagation`** —— 应用自己的右键菜单（聊天消息的 `ContextMenu`）挂在 React 的 `onContextMenu` 上、靠冒泡触发，拦了冒泡自定义菜单就一起没了；② **输入框 / 可编辑区域豁免**（`MENU_EXEMPT_SELECTOR`）：右键粘贴、拼写检查是正常需求，手机端长按粘贴更是唯一粘贴方式。要「连输入框也拦」把该选择器置空即可（`installContextMenuGuard(window, { exemptSelector: '' })`）。同样只在生产构建安装、`?dev=1` 可跳过（开发时右键审查元素是刚需） |

## 17.3 验证

| 验证项 | 结果 |
| --- | --- |
| `smoke_test`（新增 4 项） | **139 / 139**：试看响应 `no-store`、`nosniff`、**限流生效**（第 59 次请求 429）、超限文案写明「预览过于频繁」 |
| UI 定向回归 A（临时，无头 Edge 渲染真实 `ProtectedImage` / `MediaPreviewModal`） | **17 / 17** |
| UI 定向回归 B（临时，真浏览器渲染真实 `ProductCard` + 键盘守卫） | **24 / 24** |
| **生产产物探针**（临时，直接把 `client/dist` 喂给无头 Edge + 注入探针） | **6 / 6**：F12 / Ctrl+Shift+I / Ctrl+S 被拦，单独按 `u` 与 Ctrl+C 不受影响 |
| 前端 build / lint | 通过（117 模块）/ **0 error / 16 warning**（基线不变） |

UI 回归在真浏览器里断言（不是读代码）：

| 验证内容 | 结果 |
| --- | --- |
| 图片上右键 | `contextmenu` 的 `defaultPrevented === true`（默认菜单被取消） |
| 透明盾上右键 / 容器上右键 | 同样被取消 |
| 拖拽图片 / 视频 | `dragstart` 被取消；`draggable="false"` |
| 盾与图片几何 | `getBoundingClientRect` 宽高一致（完整覆盖，没有露出来的缝） |
| 计算样式 | 图片 `pointer-events: none`、容器 `user-select: none` |
| 试看视频 | 仍是 `<video controls>`（拦右键不影响播放），右键与拖拽都被取消 |
| **商城首页卡片封面** | 右键 / 拖拽被取消、`draggable=false`、盾完整覆盖封面区，**点封面仍能打开详情**（盾不吃整卡 `onClick`） |
| 键盘守卫（正例） | F12、Ctrl+Shift+I/J/C、Ctrl+U、Ctrl+S 全部 `defaultPrevented` |
| 键盘守卫（反例，防误伤） | 单独按 `u` / `s`、Ctrl+C、Ctrl+V、Ctrl+A、Enter、**F5** 一律不拦 |
| **全站右键守卫**（第三轮补） | 普通区域 / 图片 / 自定义菜单宿主上右键 → 默认菜单被拦；**应用自己的自定义右键菜单照常弹出**；`textarea` / `input` / `contenteditable` **保留**系统菜单；`exemptSelector` 置空后连输入框也拦；卸载函数有效 |
| 键盘守卫（可恢复 / 策略） | 卸载函数有效；**Vite dev 下按设计不安装**（开发者仍能按 F12） |
| 生产产物 | 真的装上了守卫（不是只在源码里写着）：页面任意处右键被拦、textarea 保留菜单、应用正常挂载 |

## 17.4 遗留 / 取舍（重要）

1. **首页卡片封面是「静态公开」的，拦右键拦不住真正的下载**：它们放在 `uploads/covers/`，
   而该目录在 `static.expose` 里（`/uploads/covers/xxx.png` 谁都能取，**连登录都不用**）。
   要让封面真正受保护，得把它从静态暴露里摘掉、改成像试看那样走**鉴权接口 + Blob**；
   但客户端目前用 `<img src="...">` 直接引用（`<img>` 带不了 Authorization 头），
   且 `config.yaml → files.types` 的自定义类型封面也指向 `/uploads/covers/...`，
   牵动面较大 —— **要不要做由你定**（这是「封面别公开」这件事的唯一实质解法）。
2. **客户端拦截（右键 / 拖拽 / 键盘）只是「提高顺手拿走的成本」**，不是安全边界：
   浏览器菜单能开开发者工具、网络面板能看请求、`blob:` 与内存里的图能直接取、截图更拦不住。
   **「防止下载」这件事前端做不到**，真正决定能拿走什么的是服务端给的是什么内容、放在哪。
3. **F12 拦不住任何一个稍微懂行的人**（§17.2 PROT-8）：它只让普通用户按不出来。
   本项目**刻意不做**「检测开发者工具打开就清空页面」这类反调试手段 —— 误报会误伤正常用户，
   且一样能被绕过，收益不抵成本。
4. **真正的解法（未做，建议做）**：试看不给交付物原件，而给**派生图** ——
   降采样（如最长边 1280）+ 打水印（查看者昵称 / 商品 ID / 时间）。
   这样即使被存下来，拿到的也不是可交付的成品。服务端已经有 ffmpeg 与转码队列
   （§15），图/视频的派生在同一条链路上做并不难；代价是试看观感下降（分辨率、水印）。
5. **限流额度**是 60 次/分钟：正常浏览绝对够（一个商品撑死十几张预览图），
   但真想批量扒的人只要放慢到 1 秒 1 张就能绕过 —— 限流挡的是「快」，不是「多」。
   要挡「多」得记录「谁看过哪些商品的试看」并做异常检测，属另一个量级的事。
6. **PDF / 文本试看**没动：`<iframe>` 里的 PDF 自带下载按钮，文本更是直接可复制
   （这两种格式的「试看」本质就是交付，服务端也没法拦）。
7. **全局右键菜单已禁用，但**输入框 / 可编辑区域保留**（这是有意的，不是漏了）：右键粘贴、
   拼写检查是正常需求，手机端长按粘贴更是唯一的粘贴方式。要「连输入框一起禁」，
   把 `installContextMenuGuard` 的 `exemptSelector` 传空串即可（已写用例验证过）。
   用户失去的：右键「复制」选中文本（Ctrl+C 仍可用）、输入框右键粘贴、拼写检查建议。
8. **手机端长按保存聊天照片也会一起失效**（右键菜单全禁的连带效果）：聊天图片本来是可以
   长按保存的，现在只能截图。如果想让聊天里的图保持可保存，把 `.msg-image / .msg-sticker`
   加进 `MENU_EXEMPT_SELECTOR` 即可 —— 要不要这么做由你定。

---

# 18 第十一轮：细节收口（A1–A3 / B1–B2 / C1–C6 / D）

本轮由使用者一次性点名处理若干悬而未决的细节问题。分四组：
**A = 真 bug（有明确行为影响）**、**B = 死代码 / 半截实现**、**C = 卫生问题（无当前影响）**、**D = `package.json` 的无效 `test:*` 注册**。

## 18.1 A 组 —— 真 bug

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | 中 | `client/src/components/shop/ProductDetailModal.jsx::selectMedia` | 视频加载失败时用户**看不到任何错误提示**（进度条停住、画面空白，无原因） | 同一个函数里 `catch` 先 `setMediaNote(err.message)`，紧接着 `finally { setMediaNote('') }` 立刻把它清掉 —— `finally` 覆盖了 `catch` 刚写入的状态 | 把清空 `mediaNote` 从 `finally` 挪到 `try` **成功路径末尾**；`catch` 里的 `setMediaNote(err.message \|\| '视频加载失败')` 保留 | ✅ |
| A2 | 中 | `client/src/utils/room.js::roomPreview()` | 一条**没带文字**的视频/音频消息，在会话列表 / 导航浮层里的摘要**显示为空字符串** | 只判了 `fileType === 'image'` 与 `'file'` 两种；`§1.60` 之后附件类型是四种（`image/video/audio/file`），视频/音频落到默认分支 `(m.text || '').slice(...)`，没文字就是空 | 补 `video → '[视频]'`、`audio → '[音频]'` 两个分支 | ✅ |
| A3 | 中 | `client/src/components/apikeys/ApiKeysModal.jsx` | 申请密钥**请求在飞时**（`creating === true`）点 ✕ / 遮罩 / Esc 都能关闭弹窗 → 服务端**已经生成了一把可用密钥**，但弹窗卸载后 `setOnce(d)` 永远没机会跑，用户**永远看不到明文** | 三个关闭出口（遮罩 `onMouseDown`、✕ 按钮 `onClick`、Esc 的 `keydown`）都没判 `creating`。对照 `UploadProductModal` / `RoleRequestModal` 都做了 `!busy` 拦截 | ① 抽出 `handleOverlayClose = () => { if (creating) return; onClose(); }` 供遮罩用；② ✕ 按钮加 `disabled={creating}`；③ Esc 的 effect 依赖数组补 `creating`，回调里 `if (e.key === 'Escape' && !creating) onClose()` | ✅ |

## 18.2 B 组 —— 死代码 / 半截实现

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 中 | `client/src/components/chat/ChatRoom.jsx`（`openBuy` + `stickerBuyProductId`）、`client/src/api/stickersApi.js` | 右键表情消息 →「购买表情包」原来是 `openView('shop', { shopTab: 'flea', category: 'sticker_pack' })`，跳到商城的「表情包」分类让用户**自己找**。同时 `ChatRoom` 里那个 `stickerBuyProductId` 状态与它的 `ProductDetailModal` 渲染分支**永远不触发**（只有 `setStickerBuyProductId(null)`，从无非空赋值） | 「直接开商品详情」的通路当时没接通，走的是「跳商城分类」的替代方案 | ① `stickersApi.js` 新增 `lookupSticker(token, url)` → `GET /api/stickers/lookup?url=`（后端早就实现，返回 `{ info: { ..., productId } }`，`productId` 只在 `pack.source === 'purchase'` 时非空）；② `ChatRoom` 的 `openBuy` 改为 `async`，先 `lookupSticker` 反查 `productId`，有就 `setStickerBuyProductId(pid)`（复活那条渲染分支、**直接打开商品详情**），没有就 `alert('这个表情包不是从商城购买的，没有对应的商品详情')`；③ `useCallback` 依赖数组同步补 `token` | ✅ |
| B2 | 低 | `client/src/components/shop/ShopPage.jsx` + `client/src/components/chat/ChatRoom.jsx` | `ShopPage` 的 `me` prop **从未被组件内部使用**，传给 `ProductDetailModal` 那边也**无人接收**（`ProductDetailModal` 只解构 `token / productId / can / onClose / onBought / onDelisted`） | 早期遗留，改组件签名时忘了删 | 两侧都删掉 `me`：`ShopPage` 函数签名去掉 `me`，`ChatRoom` 的 `<ShopPage ... />` 不再传 | ✅ |

## 18.3 C 组 —— 卫生问题（无当前行为影响）

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 低 | `client/src/components/chat/ChatRoom.jsx::buildMenuItems` | `useCallback` 依赖数组只写了 `[socket, myStickerPacks]`，漏了 `openView` 与新用到的 `token` | 当时 `openView` 恰好是 `useCallback([], ...)` 的稳定引用，侥幸没出 bug | 依赖数组改为 `[socket, myStickerPacks, token, openView]` | ✅ |
| C2 | 低 | `client/src/components/chat/MessageBubble.jsx` | 两处 `<FileTypeIcon ... mime={message.mime} />`（`msg-audio` 分支的 `size={34}`、`msg-file` 分支的 `size={38}`）—— `message.mime` **恒为 `undefined`** | 后端 `loadHistory()` 从不下发 `mime` 字段（给的是 `fileType`）。`fileKind()` 本来就按扩展名判，所以行为一直是对的，只是这个 prop 白传 | 两处都删掉 `mime={message.mime}` | ✅ |
| C3 | 低 | `client/src/components/admin/AdminRoleRequestsTab.jsx::review()` | `const note = prompt(...) ?? null` 里的 `?? null` 是多余的 | `prompt` 本来就在「取消」时返回 `null`、其他情况返回字符串；`??` 不改变结果 | 删掉 `?? null`，直接 `const note = prompt(...)` | ✅ |
| C4 | 低（仅 dev） | `client/src/components/plugins/PluginHost.jsx` | React **StrictMode 下自伤**：开发时插件加载**时好时坏** —— 一次申请票据，第一次挂载后紧跟着第一次卸载就把票据撤销了，第二次挂载拿不到有效票据 | `useEffect` 的 cleanup 里**立即**发 `DELETE /api/plugins/:id/ticket`（撤销本用户在该插件下的全部票据）。StrictMode 会跑「挂载 → 卸载 → 挂载」，第一次 cleanup 就命中。**生产构建没有 StrictMode，用户不受影响** | cleanup 里**延迟 300ms** 再撤销（`revokeTimerRef`），组件重新挂载时 `clearTimeout` 取消它。真正离开（超过 300ms 没回来）才发撤销请求。票据本身 60 秒过期，这个「加速失效」本来就只是尽力而为，不是安全边界 | ✅ |
| C5 | 低 | `client/package-lock.json` | 根节点 `name: "client"` / `version: "0.0.0"` / `react: "^19.2.8"`，与 `client/package.json` 的 `name: "wechat-chat-client"` / `version: "1.0.0"` / `react: "^19.3.0"` **不一致** | 改过 `package.json` 没跑 `npm install` 同步 lock | **无文件改动**：在 `client/` 目录跑一次 `npm install` 让 npm 以 `package.json` 为准重写 lock 根节点 | 待执行 |
| C6 | 低 | `server/package.json` | `dependencies` 里有 `@aiwayds/dsh-model-sync`，**全项目没有任何 `require` / `import`**；它还给项目引入了不必要的 `engines.node >= 22.19.0` 隐性约束（项目自身是 `>= 22.5.0`），并拖着 6 个 `@deepseek-ai/*` peerDependencies（都是 optional 但也是噪声） | 早期试装未清理 | 从 `dependencies` 删掉；`server/` 跑一次 `npm install` 同步 `package-lock.json` | ✅（同步 lock 待执行） |

## 18.4 D 组 —— `package.json` 里的 `test:*` 与脚本文件对应关系（**撤销**）

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| D | — | `server/package.json` 的 `scripts` + `server/scripts/` | 上一轮（第 11 轮）我误判为「`test:stickers` / `test:plugins` 指向的 `.mjs` 文件不存在，属无效注册」并**从 `package.json` 删除了这两行**。经用户提供 `server/scripts/` 目录清单核实：`sticker_pack_check.mjs`（23KB，2026-09-27 13:30）与 `plugin_check.mjs`（26KB，2026-09-28 22:15）**确实存在**。这两个 `test:*` 注册**有效**。 | 上一轮只看了 `package.json` 里列出的脚本名，未去 `server/scripts/` 目录核实文件是否真的存在（凭 DEVLOG §0 / §3 的「未登记」错推为「不存在」）。 | **撤销处理**：`server/package.json` **恢复** `test:stickers` / `test:plugins` 两行（与 D 组本轮无关的 C6 —— 删死依赖 `@aiwayds/dsh-model-sync` —— 保持不变）。同时按用户「D 只登记脚本」的要求，在 `DEVLOG §0` / §3 里**补登记**这两个脚本（项数与是否自包含标「待补测」，因为本轮未实测）。 | ✅（撤销 + 补登记） |

> **教训**：`package.json` 里注册的 `test:*` 与 `server/scripts/` 里的脚本文件是否对应，**必须去目录里 `ls` 核实**，不能凭「文档没登记」推断「文件不存在」—— 文档没登记 = 文档过时，不等于脚本缺失。

## 18.5 本轮验证 / 待补

**未重跑任何回归**（本轮改动集中在 UI 组件与 `package.json`，服务端断言不受影响）。建议按 §3 的顺序在 `client` 与 `server` 各跑一次 `npm install` 后全部重跑一遍，重点：
- `cd client && npm install && npm run build && npm run lint`
- `cd server && npm install && npm run test:api && npm run test:socket && npm run test:room-icon && npm run test:security && npm run test:static && npm run test:formats && npm run test:image && npm run test:file-types && npm run test:transcode`

定向验证建议（这两条**行为级**断言值得补进 `smoke_test` 之外的临时 harness）：
- **A1**：mock `previewFileBlob` 抛错，断言详情页 `<video>` 未选中时 `pd-stage-state` 里**显示错误文案**（不是空字符串）。
- **A3**：`creating === true` 时断言遮罩点击 / ✕ 按钮 / Esc 都**不能**让组件卸载（例如把 `onClose` 换成 spy）。

## 18.6 遗留（未在本轮处理）

- **D1**（用户明确要求本轮只处理「D = `package.json` 无效 `test:*` 注册」，其余 D 项不处理）：`client/update.md`（74KB 旧快照）、`client/apply_update.py`（**默认覆盖无确认**，会把 BUG-1 / BUG-2 / BUG-4 / UI-3 / §1.55 至少 5 处已修内容回退）、`client/init_structure.py`（`--force` 会清空源文件，且文件列表里还列着已删的 `ChatSidebar.jsx`）、`client/logo.jpg`（与 `public/logo.jpg` 逐字节相同的死文件）。**它们都不是运行期依赖**，删或留由使用者决定；只要不主动跑 `apply_update.py` / `init_structure.py --force`，就不会被它们咬到。
- **`server/scripts/sticker_pack_check.mjs` / `plugin_check.mjs` 是否要新建**：本轮 D 的处置是**删掉无效注册**而不是新建脚本。如果后续确实要补这两套回归，需要先写脚本，再同步 `package.json` 加回 `test:*`，并在 `DEVLOG §0` / §3 登记。
| UI-4 | 中 | `client/src/styles/index.css`（`.message` / `.date-separator` / `.chat-area` / `.messages-wrap`）、`client/src/components/chat/MessageList.jsx` | 滑到最后一条消息时气泡**无法完全显示**（下边缘被裁），继续向下滚会**诡异抖动** | 三个独立原因叠加：① `.message` / `.date-separator` 的间距用 `margin` 撑，而 **Virtuoso 计算 item 高度时用 `offsetHeight`，`margin` 不计入** → 它算的每条消息高度比实际视觉少 16px，永远比实际早一点判「到底」；② `.chat-area` / `.messages-wrap` 缺 `min-height: 0`，flex 子项默认 `min-height: auto` → Virtuoso 拿到的可用高度在边界下算错，最后一段被 `overflow: hidden` 裁；③ `atBottomThreshold={120}` 让用户还没到底就被判「在底部」，而 `followOutput: 'smooth'` 是动画滚动，任何高度重算都打断它并重触发 → 「滚 → 被打断 → 再滚」的拉锯 = 抖动 | ① `.message` / `.date-separator` 的 `margin` 改 `padding`（含 `@media 768px` / `480px` 两处）；② `.chat-area` / `.messages-wrap` 补 `min-height: 0`；③ `MessageList` 的 `atBottomThreshold` 120 → 40、`followOutput` 由常量 `'smooth'` 改为 `(isAtBottom) => isAtBottom ? 'auto' : false`，另加 `increaseViewportBy: { top: 400, bottom: 400 }` 与 `computeItemKey`（用 `msg.id` 追踪 item） | ✅ |
## 19. 认证架构改造：JWT localStorage → Cookie + 刷新令牌

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AUTH-1 | 高 | `client/src/utils/authStorage.js`、`client/src/api/http.js` | JWT 存 localStorage，有效期 7 天 | XSS 一次即可长期窃取；服务端无撤销能力 | 双 token：Access（JWT 15m，内存）+ Refresh（HttpOnly Cookie，30d，Path=/api/auth，SameSite=Strict，Secure 按环境自动）；Refresh 落库 + 轮换 + 重放检测 | ✅ |
| AUTH-2 | 中 | `server/src/auth/index.js` | 无法区分"access 过期"与"token 无效"，前端只能笼统重新登录 | 无 `code` 字段 | 401 响应带 `code: 'TOKEN_EXPIRED' \| 'TOKEN_INVALID'` | ✅ |
| AUTH-3 | 中 | 多标签页 / 并发请求同时 401 | 会并发触发多次刷新，出现 token 竞态 | 无去重 | `session.refresh()` 用单一 in-flight Promise 去重 | ✅ |
| AUTH-4 | 中 | `useSocket` 重连 | Access 过期后 socket 重连失败，客户端拿失效 token 无限重连 | 与 HTTP 通道的刷新机制未打通 | `connect_error` 识别认证类错误 → 调 `session.refresh()` → 成功则重连 | ✅ |
---

# 19. 认证架构改造：JWT localStorage → Cookie + 刷新令牌

**背景**：项目原本是「7 天 JWT 存 localStorage」的单 token 方案。业务逻辑与权限校验在历次审计中都通过，但认证架构本身有两个无法在应用层解决的结构性问题：
1. **长期凭据暴露给 JS**：localStorage 里的 token 一旦被 XSS 读到就是长期有效；
2. **不可撤销**：JWT 无状态，签发后服务端管不了它 —— 登出、改密码、封号、发现泄露，都踢不掉已签发的 token。

改造目标：**长期凭据不进 JS 可见区域；长期凭据可撤销**。

**方案**：
- **Access Token**（JWT，15m）：响应体返回，前端内存持有，请求带 `Authorization: Bearer`。短命 → 被盗窗口小 → 不需要为它做撤销（省掉每次请求查库）。
- **Refresh Token**（随机串，30d）：HttpOnly Cookie（`Path=/api/auth`、`SameSite=Strict`、`Secure` 按环境自动）。只用于 `/api/auth/refresh`。落库（只存 SHA-256），每次刷新**轮换**，用已撤销的来刷新 = 重放信号 → **整族作废**。
- **CSRF**：Access 不在 Cookie（天然免疫）；Refresh 端点靠 `SameSite=Strict` + `Origin/Referer` 校验兜底。
- **Socket**：握手 `auth.token` 传 Access（socket.io 不走 Cookie；Access 本来就不在 Cookie）。
- **API 密钥通道**：独立不变（脚本走 `X-API-Key`）。

| 编号 | 级别 | 位置 | 现象 | 根因 | 修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AUTH-1 | 高 | `client/src/utils/authStorage.js`、`client/src/api/http.js` | JWT 存 localStorage，有效期 7 天 | XSS 一次即可长期窃取；服务端无撤销能力（改密码 / 封号 / 泄露后无法踢下线） | 双 token：Access（JWT 15m，前端内存）+ Refresh（HttpOnly Cookie，30d，Path=/api/auth，SameSite=Strict，Secure 按环境自动）；Refresh 落库 + 轮换 + 重放检测 | ✅ |
| AUTH-2 | 中 | `server/src/auth/index.js` | 401 无法区分「access 过期」与「token 无效」，前端只能笼统重新登录 | 401 响应体没有 `code` 字段 | 401 响应带 `code: 'TOKEN_EXPIRED' \| 'TOKEN_INVALID' \| 'NO_TOKEN' \| 'USER_INACTIVE'`；前端据此决定是否值得走刷新（只在 TOKEN_EXPIRED / TOKEN_INVALID 时重试） | ✅ |
| AUTH-3 | 中 | 多标签页 / 并发请求同时 401 | 会并发触发多次刷新，出现 token 竞态（旧的刷新响应覆盖新的） | 无去重 | `client/src/auth/session.js::refresh()` 用单一 in-flight Promise 去重：并发请求等它完成后重放；`_retried` 标记防止「刷新→重试→再刷新」的无限循环 | ✅ |
| AUTH-4 | 中 | `client/src/hooks/useSocket.js` | Access 过期后 socket 重连失败，客户端拿失效 token 无限重连 | socket 通道的刷新机制与 HTTP 通道未打通 | socket `connect_error` 识别认证类错误（`/登录已过期\|未登录\|用户不存在\|已被禁用/`）→ 调 `session.refresh()` → 成功则用新 token 重连；失败才派发 `auth:expired` 让 App 回登录页 | ✅ |
| AUTH-5 | 中 | `server/src/services/refreshTokens.js` | 老库遗留的 `bound_ip IS NULL` 类「无绑定」问题在 refresh_tokens 上同样存在潜在风险 | 历史数据迁移策略 | **没有历史数据**（新表）：直接不做「首次使用就地补写」，所有 refresh_tokens 行从创建起就带完整 `family_id` / `user_id`；将来若有人手工插入不完整行，`rotate()` 会因 `family_id` 缺失而在事务里抛错回滚 | ✅ |

**部署注意**：

- 单端口（推荐）`http://<IP>:3001` → `config.IS_PROD=false` 时**不设** `Secure`（局域网 http 无法设）；
- HTTPS 反代 → `X-Forwarded-Proto: https` + `config.TRUST_PROXY=true` 时自动设 `Secure`；
- dev 模式 `http://127.0.0.1:5173` → 无 Secure；Vite 代理转发 Cookie，同源无跨站问题。

**首次上线的影响**：所有已登录用户会被登出（旧 localStorage JWT 不再被识别为 Refresh）；用户下次访问 → 未登录 → 重新登录一次，之后走新流程。

**测试脚本**：三套打真实库的套件（`smoke_test.mjs` / `socket_check.mjs` / `room_icon_check.mjs`）无需改动 —— 注册响应的 `token` 字段作为 `accessToken` 的**兼容别名**保留，脚本继续用 Bearer 通道即可（access_ttl=15m 远长于测试时长）。稳定 30 天后可将 `security.auth.allow_legacy_bearer` 改为 `false` 并删除 `token` 兼容别名。