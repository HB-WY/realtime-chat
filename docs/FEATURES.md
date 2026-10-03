# 新增功能说明（偏好 / 资源池 / 表情包 / 商城外观素材 / API 密钥 / 房间图标）

本轮改动在原有「WeChat 风格聊天 + 商城」之上新增六块能力。**未设置任何新功能的账号，
界面与行为与改动前完全一致**（所有外观都通过 CSS 变量 + 原值兜底实现）。

> 第六块「房间图标」见 §六；两个纯界面调整（列表常驻、方形圆角头像）见 §七。

---

## 一、用户偏好存储（跨设备同步）

### 数据表

| 表 | 作用 |
| --- | --- |
| `user_preferences` | `user_id` 主键，`background`（全局背景）、`bubble`（气泡配置 JSON）、`font_size`（字号） |
| `room_preferences` | `(user_id, room_key)` 主键，`background`（单房间背景） |

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/preferences` | 返回 `{ global, rooms, limits }` |
| PUT | `/api/preferences` | 局部更新：`{ global?, room?, rooms? }` |
| PUT | `/api/preferences/room/:roomKey` | 只改某个房间的背景 |
| DELETE | `/api/preferences/room/:roomKey` | 清除某个房间的背景 |

返回结构：

```json
{
  "global": { "background": "#112233", "bubble": { "self": { "bg": "#000", "color": "#fff", "radius": 10 } }, "fontSize": 17, "updatedAt": 1700000000000 },
  "rooms": { "public": { "roomKey": "public", "background": "#445566", "updatedAt": 1700000000000 } },
  "limits": { "fontMin": 12, "fontMax": 20, "maxRooms": 200, "backgroundMaxLen": 500, "bubbleMaxLen": 4000 }
}
```

- **未设置时所有字段为 `null`**，前端不注入任何 CSS 变量 → 表现与现状一致。
- `background` 只接受 `#RGB/#RRGGBB/#RRGGBBAA` 或 `/uploads/...` 图片路径（服务端校验，拒绝 `javascript:` 之类的注入）。
- `room_key` 取值 `public` / `p_<id>_<id>` / `g_<id>`，并校验访问权（私聊必须是参与者、群聊必须是成员）。
- 清除某项 = 发送 `null`。
- 前端入口：侧边栏「外观」按钮 → 背景（预设色 / 自定义色 / 我的背景素材 / 上传）、单会话背景、气泡主题（预设 / 逐项配色 / 我的气泡素材 / 圆角）、字号（12–20px），弹窗内实时预览。

```bash
curl -X PUT http://localhost:3001/api/preferences \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $JWT" \
  -d '{"global":{"background":"#eef3f8","fontSize":16},"room":{"roomKey":"public","background":"#fdf6e3"}}'
```

---

## 二、统一资源池（assets）

- 表 `assets`：`id / owner_id / kind / sha256 / url / file_name / mime / size / meta / source / ref_type / ref_id / created_at`。
- `kind`：`image | background | bubble | sticker`。
- 限制：**PNG / JPG / GIF / WebP / BMP / AVIF，单文件 ≤500MB；单次上传总量 ≤500MB；用户总量配额默认不限**（`quota_bytes: 0`，可按需改回）。
  - HEIC / HEIF / TIFF **不收**：桌面浏览器渲染不了，存下来就是一张裂图。手机拍的 HEIC 由前端
    `utils/image.js` 在上传前转成 JPEG（在能解码的手机浏览器里），桌面浏览器解不开时给出可执行提示。
  - 前端会在上传前统一压缩（长边 ≤2560 / ≤8MB，表情 ≤512 / ≤2MB），并**按 EXIF 方向解码**，
    所以手机直出的大照片与竖拍照片都能正常上传、不会横躺。
- **按 sha256 去重**：落盘路径固定为 `uploads/custom/{userId}/{sha256}{ext}`，同内容只存一份文件；
  同一用户 + 同一用途 + 同一内容只保留一条记录，配额按 `sha256` 去重计量。
- `uploads/custom` 已加入静态暴露列表（`static.expose`）——聊天里对端必须能直接取到表情 / 背景图片。
  该目录只读、只回图片，仍走原有的 CSP / `X-Content-Type-Options` / 危险扩展名降级逻辑。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/assets/upload` | 字段 `file` 或 `files`（≤50），可带 `kind` |
| GET | `/api/assets?kind=&limit=` | 我的资源列表 + 用量 |
| GET | `/api/assets/quota` | `{ used, files, quota, batchMax, maxFileSize }` |
| GET | `/api/assets/:id` | 详情 |
| DELETE | `/api/assets/:id` | 删除（被表情包引用时拒绝） |

```bash
curl -X POST http://localhost:3001/api/assets/upload \
  -H "Authorization: Bearer $JWT" -F 'kind=background' -F 'file=@bg.png'
```

前端入口：侧边栏「我的资源」。

---

## 三、表情包系统

| 表 | 作用 |
| --- | --- |
| `sticker_packs` | 表情包（`is_public` / `share_code` / `source`） |
| `sticker_items` | 表情项（图片指向资源池资产） |
| `user_sticker_packs` | 用户 ↔ 表情包关联（`own` / `subscribe` / `purchase`） |

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / POST | `/api/stickers/packs` | 列表（我拥有 + 我订阅）/ 创建 |
| GET / PATCH / DELETE | `/api/stickers/packs/:id` | 详情 / 改名改简介 / 删除 |
| POST | `/api/stickers/packs/:id/items` | 批量上传表情（字段 `files`，≤50 张，每张 ≤10MB） |
| PUT | `/api/stickers/packs/:id/items/order` | 排序 `{ order: [itemId...] }` |
| DELETE | `/api/stickers/packs/:id/items/:itemId` | 移除表情 |
| POST | `/api/stickers/packs/:id/share` | 设为公开并生成分享码（`{ regenerate: true }` 重新生成） |
| POST | `/api/stickers/packs/:id/private` | 停止公开 |
| POST | `/api/stickers/subscribe` | 凭分享码订阅 `{ code }` |
| DELETE | `/api/stickers/subscribe/:packId` | 取消订阅 |

**订阅只建关联、不复制文件**：订阅者读到的始终是原包内容，作者新增 / 排序 / 改名后，
订阅者下一次读取立刻可见；同时服务端通过 socket 推送 `stickers:pack:updated` /
`stickers:pack:removed` / `stickers:pack:subscribed`，前端表情面板收到即刷新。

发送表情复用现有消息通道：消息体带 `isSticker: true`（数据库 `messages.is_sticker`），
渲染时不带气泡底色。前端入口：输入区「表情包」按钮（面板内可「管理」），侧边栏「表情包」。

---

## 四、商城整合

### 商品分类

`products.category` 新增：`goods`（默认，普通商品）/ `background`（聊天背景）/
`bubble`（气泡主题）/ `sticker_pack`（表情包）。`GET /api/shop/catalog` 返回可选分类。

### 价格下限 1 → 0

`business.shop.price.min: 0`，免费商品可上架、可购买，**走与付费商品完全相同的流程**：

- 同样做 sha256 + simhash 抄袭检测（标题+描述文本哈希 + simhash 相似度）；
  另外新增 `products.file_hash`，对**素材文件本身**做 sha256 比对 —— 换标题重发同一份文件同样会被拦下并自动下架为 `pirated`；
- 同样进入标准市场「待开发者定价」审核（`/api/admin/shop/review/:id`），审核时可定价为 0；
- 同样受 `hide` / `unhide` / `delist` / 审计日志约束，**无任何豁免**；
- 同样记录积分流水与订单（免费商品流水 delta = 0，订单价格 = 0）。

### 购买后归入买家资源库

购买 `background` / `bubble` / `sticker_pack` 商品后，商品文件会被复制进
`uploads/custom/{buyerId}/` 并写入 `assets`（`source='purchase'`, `ref_id=商品ID`）：

- 背景 → `assets.kind='background'`，可直接在「外观」里选用；
- 气泡主题 → `assets.kind='bubble'`，商品里的 `theme.json`（可选）会被解析并存入 `assets.meta`，
  前端一键套用整套配色；没有 json 时可用图片素材；
- 表情包 → 在买家名下新建一个表情包（`source='purchase'`）并自动加入其表情列表，聊天里直接可用。

### 行为说明（明确的取舍）

- 普通商品保持原有「售出即下架」（`sold`）语义；
  **外观素材类商品可被多人购买**（数字素材授权），否则「素材商店」无意义。这是唯一的行为差异，
  且只作用于新增的三类 category。
- 外观素材商品必须包含至少一张图片文件（否则购买后无法使用）。

前端入口：商城顶部新增分类筛选条，上架弹窗新增「商品分类」选择，卡片/详情显示分类标签与「免费」。

---

## 五、API 密钥体系（独立于 JWT 的第二认证通道）

| 表 | 作用 |
| --- | --- |
| `api_keys` | `key_hash`（SHA-256）、`prefix`（12 位）、`last_used_at`、`last_ip`、`revoked_at` |
| `apikey_ip_claims` | `ip` 主键 → 绑定用户；撤销密钥不释放，仅管理员可释放 |

### 认证规则

- 明文格式 `rk_<12 位前缀><40 位随机>`，**申请时只返回一次**；库里只有 SHA-256 哈希与 12 位前缀。
- 请求头：`X-API-Key: rk_...`，或 `Authorization: ApiKey rk_...`。（`?api_key=` URL 参数通道已移除：密钥会泄露进日志 / Referer / 浏览器历史。）
- **同一 IP 只能绑定一个用户**：申请时占用；使用时若不是绑定者直接 403。
  撤销密钥**不释放** IP 绑定（`apikey_ip_claims` 只标记 `released_at`，需要管理员手动释放）。
- **账号被封禁 / 禁用即时失效**：每次请求都重新载入用户状态；封禁时同时撤销其全部密钥。
- 独立按密钥限流（`rate_limits.apikey`，默认 600 次/分钟），**不复用 JWT 通道规则**；
  另有每 IP 每分钟失败次数上限，防暴力枚举。
- 前缀查找 + 定时安全比较；连续失败过多返回 429。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/keys` | 申请密钥（返回一次性明文、12 位前缀、绑定 IP） |
| GET | `/api/keys` | 列表（只显示前缀、掩码、创建时间、最近使用时间、状态） |
| POST | `/api/keys/:id/revoke`、DELETE `/api/keys/:id` | 撤销 |
| GET | `/api/keys/whoami` | 当前密钥自检（返回 `authType`、前缀、IP） |
| GET | `/api/admin/apikeys/ip-claims` | 管理员查看 IP 绑定（`?all=1` 含已释放） |
| POST | `/api/admin/apikeys/ip-claims/release` | 管理员释放 `{ ip }` 或 `{ userId }`（需要 `manage_apikeys` 能力，默认 50 级＝管理员） |

### 覆盖范围

- `/api/*` 同时接受 JWT 与 API 密钥 → **所有现有受 JWT 保护的接口**（消息、好友、群聊、积分、
  商城、角色、管理接口等）脚本带密钥都能等价调用。
- `/api/v1/*` 是**只认密钥**的专用前缀（带 JWT 访问返回 401），同一套路由。
- 原本只存在于 Socket.IO 的操作，新增 REST 镜像（`src/routes/v1.js`，与 socket 共用
  `src/services/chat.js`，行为一致且同样会实时推送）：

| 方法 | 路径 |
| --- | --- |
| GET | `/api/v1/state`（用户 + 好友 + 群 + 待处理申请 + 在线 + 积分） |
| GET | `/api/v1/presence/online`、`/api/v1/users/search`、`/api/v1/groups/search` |
| GET / POST | `/api/v1/messages`（读历史 / 发消息，支持 `isSticker`） |
| POST | `/api/v1/messages/:id/recall`、`/api/v1/messages/:id/read` |
| GET / POST | `/api/v1/friends/requests`（列表 / 发起申请） |
| POST | `/api/v1/friends/requests/:id/accept`、`/api/v1/friends/requests/:id/reject` |
| DELETE | `/api/v1/friends/:id` |
| POST | `/api/v1/groups`，GET/PATCH `/api/v1/groups/:id` |
| POST | `/api/v1/groups/:id/requests`、`/api/v1/groups/requests/:id/approve`、`/reject` |
| POST | `/api/v1/groups/:id/members`（邀请） |
| DELETE | `/api/v1/groups/:id/members/me`（退群）、`/api/v1/groups/:id/members/:userId`（移出） |

```bash
# 1) 浏览器里申请密钥后，脚本即可直接调用（不再需要 curl 搞定 JWT）
curl -H "X-API-Key: rk_xxxxxxxxxxxx..." http://localhost:3001/api/v1/state

# 2) 发消息
curl -X POST http://localhost:3001/api/v1/messages \
  -H "X-API-Key: rk_xxxxxxxxxxxx..." -H 'Content-Type: application/json' \
  -d '{"roomType":"public","roomId":"public","text":"hello"}'

# 3) 发一个表情（复用消息通道，带 isSticker）
curl -X POST http://localhost:3001/api/v1/messages \
  -H "X-API-Key: rk_xxxxxxxxxxxx..." -H 'Content-Type: application/json' \
  -d '{"roomType":"public","roomId":"public","fileUrl":"/uploads/custom/1/xxx.png","fileType":"image","isSticker":true}'
```

前端入口：侧边栏「API 密钥」（申请 / 一次性明文 + 复制 / 列表 / 撤销 / curl 帮助），
管理面板「API 密钥」页签（IP 绑定列表 + 手动释放）。

---

## 六、房间图标（站点 / 导航栏 / 公共聊天 / 群）

### 1）站点图标 + 导航栏图标

- 唯一图源：**`client/public/logo.jpg`**（构建后落在 `dist/logo.jpg`，开发时 Vite 直接托管）。
  `index.html` 用它当 `rel="icon"` 与 `apple-touch-icon`，不再有 `favicon.ico 404`。
- 左侧导航栏顶部的品牌标换成该图片，并加了内描边 + 外发光 + 更大圆角的「高级感」样式；
  图片加载失败时自动回落为字符「聊」，不会出现裂图。
  换图只需替换 `client/public/logo.jpg`。

### 2）公共聊天图标（仅开发者）

公共聊天（`roomType='public'`, `roomId='public'`）不是数据库实体，图标单独存：

| 表 | 作用 |
| --- | --- |
| `room_settings` | `room_key` 主键（目前只有 `'public'`）、`icon`、`updated_by`、`updated_at` |

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/rooms/public` | 公共聊天房信息 `{ roomKey, type, name, icon, updatedAt }`（任何人可读） |
| PUT | `/api/rooms/public/icon` | `{ icon }`，`''` = 清除；需要 `manage_public_room` 能力 |

- 权限走现有能力体系：`roles.capabilities.manage_public_room: 100`，
  即**只有开发者**（`can('manage_public_room')`；前端入口也由 `can()` 派生，不硬编码）。
- `icon` 与用户头像同一套净化规则（`utils/avatar.js`）：`/uploads/...`、`http(s)://`、
  `data:image/...` 或**单个 emoji / 字符**；`javascript:` 之类只会被取首字符，不会注入。
- 开发者换完图标后，服务端 `registry.broadcastAll('room:public:updated')` 全服推送，
  所有在线用户的会话列表与聊天头部即时更新；`state:init` 也带 `publicRoom`。
- socket 等价事件：`room:public:get`、`room:public:icon`（`services/rooms.js` 唯一实现）。

### 3）群图标（群主 / 群管理员）

- 复用 `groups.avatar`：`/uploads/...` 图片 URL、外链、`data:image/` 或单个 emoji。
- `chat.updateGroup` 改为**按字段判权限**：
  - `avatar`（群图标）→ 群主 **或** 群管理员；
  - `name`（群名）→ **仍然只有群主**。
- 群管理员是真实角色：`group_members.role = 'owner' | 'admin' | 'member'`，
  由**群主**任免（不能任免群主自己）。成员列表按 群主 → 管理员 → 成员 排序，
  群里显示「群主 / 管理员」标签。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| PATCH | `/api/v1/groups/:id` | `{ avatar }`（群主/管理员）、`{ name }`（仅群主） |
| POST | `/api/v1/groups/:id/members/:userId/role` | `{ role: 'admin' \| 'member' }`，仅群主 |
| socket | `group:update`、`group:member:role` | 与上面等价，共用 `services/chat.js` |

改动后同一群的成员会实时收到 `group:updated` + `group:list`，会话列表图标立刻刷新。

### 4）前端入口与控件

- 会话列表 / 群列表 / 导航浮层 / 聊天头部的房间图标统一用 `Avatar` 组件渲染
  （图片 → emoji → 首字母三态自动降级）。
- 群信息页：群主 / 群管理员可展开「设置群图标」（`RoomIconEditor`：32 个 emoji 预设 + 上传图片 + 清除）；
  群主还能对成员「设为管理员 / 取消管理员」。
- 公共聊天：开发者可从导航「素材 → 公共聊天图标」或聊天头部「更换图标」进入
  `PublicRoomIconModal` 整页设置；普通用户看不到任何入口。

### 5）验证

```bash
cd server
node scripts/room_icon_check.mjs      # 41 项：权限 / 净化 / 群主与管理员边界 / 列表下发

cd client
node ../server/scripts/socket_check.mjs   # 37 项：含公共聊天图标全服广播、群图标实时下发
```

---

## 七、界面调整（列表常驻 / 方形圆角头像）

### 1）聊天列表不再折叠

- `ListPanel` 去掉折叠态：删除「收起列表」按钮与收起后的窄条，
  `.panel-toggle` / `.panel-restore` 样式与 `ui_list_collapsed` 持久化标记一并清除。
- 列表在 chat 视图下**常驻显示**（宽 300px；窄屏仍按原有响应式占满宽度并纵向排布）。
  老用户 localStorage 里残留的 `ui_list_collapsed=1` 会被无视，不会出现「列表消失」。

### 2）头像统一改为方形圆角

- 全站头像只有 `components/common/Avatar.jsx` 一个实现，改动一处即全局生效：
  圆角 = **尺寸 × 0.3**（36px → 11px、64px → 19px、72px → 22px），随尺寸等比缩放。
- 覆盖范围：会话列表 / 群列表 / 聊天头部 / 消息气泡 / 成员列表 / 导航账户 /
  群信息大图标 / 房间图标编辑器预览 / 发现群聊结果 / 商城作者信息等。
- 与已有的导航栏品牌图标（11/34≈32%）、emoji 选择格（8px 圆角）观感一致；
  仍然保持圆形的只有状态点 `.dot`、打字动画小点、图片灯箱关闭键这类非头像元素。

---

## 八、附件预览与商品图集（视频/音频内联播放 · 文件类型图标 · 试看）

### 1）聊天附件按类型分流

`POST /api/file` 现在返回 `kind`：`image` / `video` / `audio` / `file`（由上传的 MIME 决定），
前端据此决定渲染方式：

| kind | 渲染 |
| --- | --- |
| `image` | 气泡内 `<img>`，点击进全屏灯箱 |
| `video` | 气泡内 `<video controls preload="metadata" playsInline>`（**不自动播放**，否则群聊里多个视频会一起加载） |
| `audio` | 类型图标 + 原生 `<audio controls>` 播放条 |
| `file` | 文件卡片（图标 + 文件名 + 大小），点击下载/新窗口打开 |

**播不了先问后端，救不回来才退回卡片**（第九轮起，见 §九）：
`avi / mkv / flac` 这类浏览器不一定解码得了，前端不预判，而是真去加载；`onError` 时**先问
`/api/media/status`**——服务端有本地 ffmpeg，能转的会当场排队转码（气泡里显示进度，转好自动播放），
只有「转不了 / 没装 ffmpeg / 文件损坏」才把播放器换成文件卡片并说明原因。

### 2）文件类型图标（`components/common/FileTypeIcon.jsx`）

11 类：`word / excel / ppt / pdf / text / code / archive / audio / video / image / file`，
按扩展名归类、MIME 兜底；颜色沿用品牌色（Word `#2b579a`、Excel `#217346`、PPT `#d24726`、
PDF `#e33e33`、压缩包 `#f0a500`…）。

- 品牌图形（Word / Excel / PowerPoint / Acrobat / 7-Zip）的路径数据取自 **simple-icons（CC0-1.0）**，
  通过 jsDelivr 取单个 SVG 后把 `<path d>` **内联**：零依赖、不在运行期请求网络。
- 其余类型为自绘 SVG。**全部是内联 SVG，不用 emoji、不用文字方块**
  （原来的 `getFileMeta()`「字母 + 底色」实现已删除，避免两套并存漂移）。
- 同时提供纯函数 `fileKind(name, mime) → { key, label, color }` 给需要判类型的逻辑复用。

### 3）商品图集（京东式）

详情页主图区 = **封面 + 卖家勾了「预览」的图片/视频**，下方是缩略图条（选中态高亮，
视频缩略图带 CSS 播放角标），选中视频时主图位切换为 `<video>`。

实现上**不需要改库**：`product_files.is_preview` 本来就是「这份文件允许试看」的标记。
卖家把图片/视频当商品文件上传并勾选「预览」，详情页就自动长出图集。
封面与图片类预览走鉴权 Blob（`uploads/shop` 未静态暴露），视频**点中才加载**（避免一进详情页就下整段视频）。

### 4）试看（未购买可预览）

| 接口 | 说明 |
| --- | --- |
| `GET /api/shop/preview/:productId/:fileId` | 登录即可，**不需要购买**；只放行 `is_preview = 1` 的文件，否则 404。按用户限流 `rate_limits.preview`（默认 60 次/分钟），响应带 `Cache-Control: no-store` + `nosniff` |
| `GET /api/shop/download/:productId/:fileId` | 仍需购买（或本人 / 有 `delist_product`），并写下载审计 |

前端在文件列表里给勾了预览的文件加「预览」按钮，未购买时下载位显示「未购买」——
这就是「先看图、买后再下载」的模型，不是绕过付费。

**商城里的图不能顺手另存**：首页卡片封面、详情页图集、试看浮层里的图片统一走 `ProtectedImage`
（右键菜单、拖拽、手机长按都拦掉，图片上盖一层透明盾），视频 / 音频也拦掉右键「另存为」
（原生控制条照常可用）；页面级还有两道守卫 —— **全站禁用浏览器默认右键菜单**（应用自己的
自定义右键菜单照常弹出）与拦截 **F12 / Ctrl+Shift+I·J·C / Ctrl+U / Ctrl+S** 这些开发者快捷键。

> **两个守卫都只在生产构建里生效**：`npm run dev` 下不拦（开发时右键审查元素、F12 都是刚需），
> 生产里给页面加 `?dev=1` 也可临时放开。
>
> **输入框是豁免的**：聊天输入框 / 搜索框 / 可编辑区域的系统右键菜单保留（右键粘贴、
> 拼写检查；手机端长按粘贴更是唯一的粘贴方式）。想让输入框也禁掉，把
> `installContextMenuGuard` 的 `exemptSelector` 传空串即可。
>
> **它们不是安全边界**：浏览器菜单照样能开开发者工具，网络面板、`blob:` 地址、截图也拦不住，
> 首页卡片封面还是**静态公开**文件（`/uploads/covers/...` 直接就能取）—— 前端只能让「顺手拿走」变麻烦。
> 真正决定「能拿走什么」的是服务端给的**内容**：目前试看给的就是交付物原件，
> 彻底解法是给**降采样 + 水印**的派生图，并让封面也走鉴权通道（两者都尚未做）。
> 能约束脚本的只有服务端限流。
>
> **连带效果**：右键全禁之后，手机端**长按保存聊天照片**也会失效（只能截图）。
> 想让聊天图片保持可保存，把 `.msg-image / .msg-sticker` 加进 `MENU_EXEMPT_SELECTOR`。

预览浮层（`components/common/MediaPreviewModal.jsx`）类型支持：

| 类型 | 渲染 |
| --- | --- |
| 图片 | `ProtectedImage`（`<img>` + 右键/拖拽拦截） |
| 视频 | `<video controls>`（自动播放，因为是用户主动点的；拦右键另存） |
| 音频 | `<audio controls>`（同样拦右键） |
| PDF | `<iframe>`（交给浏览器内置阅读器） |
| 文本 / 代码 | `<pre>`，上限 200 KB，超出提示下载 |
| 其他（Word/Excel/PPT/压缩包…） | 明确提示「无法在线预览，请下载后用本地程序打开」 |

### 5）验证

- `cd server && node scripts/smoke_test.mjs` → **139 项**（含 4.5 节：附件分类 4 + 试看 10）
- 临时 UI 回归（无头 Edge 渲染真实组件，31 项，跑完已删）：视频/音频元素与属性、
  播放失败回落、文件卡片 SVG 与品牌色、图集缩略图与主图切换、预览浮层（文本/视频）、
  未购买时「预览可用而下载不可用」。

### 6）开发者新增文件类型 / 给类型配封面

内置 11 类之外的扩展名（`.psd` / `.apk` / `.dwg`…）**不用改代码**，在 `config.yaml`（或 `config.local.yaml`）里加即可：

```yaml
files:
  types:
    - key: psd
      label: PSD              # 卡片角标，≤6 字；不写则用 key 大写
      color: '#31a8ff'        # 主色；不写则 #64748b
      exts: ['.psd', '.psb']  # 至少一个，大小写不敏感
      cover: '/uploads/covers/psd.png'   # 封面图；不写则用内置通用图形
    - key: video              # key 与内置同名 → 覆盖内置类型的颜色/封面
      exts: ['.mp4', '.mov']
      cover: '/uploads/covers/video.png'
```

- **改完重启后端即生效，不需要重新构建前端**（前端通过 `GET /api/file-types` 拉取，见 `server/src/routes/fileTypes.js`）
- 封面图：用任意账号上传图片（头像上传 / 我的资源），把返回的 `/uploads/...` 填进 `cover`；也支持 `http(s)` 外链与 `data:image/`
- 自定义类型**优先于**内置：同一扩展名或同一 key 都以配置为准
- 非法条目（key 不合法 / 没有合法扩展名 / key 重复 / 封面 scheme 不支持）只打警告并跳过，**不会让后端起不来**
- 类型表是**显示层**：某个扩展名能不能**上传**仍由 `uploads.avatar.allowed_ext`、`business.assets.allowed_ext` 决定（聊天附件不限类型），两者有意分开

验证：`cd server && node scripts/file_types_check.mjs`（15 项，自包含隔离实例），或 `npm run test:file-types`。

## 九、任意格式音视频都能播（本地 ffmpeg 转码）

浏览器只认有限的「容器 + 编码」组合：mp4/mov 里的 h264+aac、webm 里的 vp8/vp9/av1+opus/vorbis、
mp3/m4a/flac/wav。手机录屏、下载器、剪辑软件丢进来的 **mkv / avi / flv / wmv / rmvb / wma**，
以及「`.mp4` 里装 HEVC」这种文件名看着没问题的，浏览器一律播不了 —— 以前只能退回文件卡片，
让用户下载后用本地播放器打开。

现在只要机器上装了 ffmpeg（PATH 里有 `ffmpeg` / `ffprobe`，或在 `config.yaml` 里写绝对路径），
后端会把**播不了的那一份**转成可播副本，前端自动用它播放：

| 情况 | 行为 |
| --- | --- |
| 本来就能播 | 原样播放，**不产生任何副本**（不做多余动作） |
| 编码 OK、容器不对（mkv 里的 h264+aac） | 只换壳（`-c copy -movflags +faststart`），通常秒级 |
| 编码不对（avi/mpeg4、wma/wmav2、mp4 里的 HEVC…） | 转成 mp4（h264+aac）/ mp3 |
| 正在转码 | 气泡里显示进度条与「视频正在转码 42%…」，转好**自动换成播放器**，不用刷新 |
| 转不了（没装 ffmpeg / 文件损坏 / 不是媒体） | 退回文件卡片并说明原因，下载后用本地播放器打开 |

四个要点：

- **原件永远不动**：转码只产出 `uploads/files/tc/<同名>.mp4|.mp3` 副本。下载、商品交付拿到的
  始终是上传的那一份（逐字节不变），副本只服务「在线播放」。
- **商品试看同样受益**：卖家上架的 mkv 视频，`?playback=1` 拿到的是可播副本；还没转好时接口回
  `202` + 进度，前端显示「源格式浏览器播不了，服务器正在转码 …%」。`/api/shop/download`
  与不带参数的预览通道仍然给原件。
- **老附件自动补转**：转码功能上线**之前**就存在的附件，第一次被播放时会自动入队，不用重传。
- **没装 ffmpeg 不影响别的**：上传照常，播不了退回卡片（旧行为），启动时只有一条警告，
  绝不因为缺少 ffmpeg 让服务起不来。

判断「要不要转」用的是 ffprobe 探测出来的**容器 + 编码**，不是文件扩展名 ——
只看扩展名会漏掉 `.mp4` 装 HEVC，只看编码会漏掉 `.mkv` 装 h264。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/media/status?src=/uploads/files/x.mkv` | 要不要转 / 转好没 / 该播哪个地址（**幂等**，会顺手入队，历史附件靠它自愈） |
| GET | `/api/media/transcode` | 诊断：ffmpeg 是否就绪、队列里有多少活 |
| GET | `/api/shop/preview/:productId/:fileId?playback=1` | 试看可播副本：`200` 直接给（支持 Range）、`202` 还在转（带 `progress`）、`409` 失败 |

`POST /api/file` 与 `POST /api/shop/upload` 的响应新增 `playback` 字段
（`{ needed, status, playUrl, progress, error, reason }`），前端据此在附件还没发出去时
就能提示「服务器会转成可在线播放的格式」。

### 配置（`config.yaml`）

```yaml
media:
  transcode:
    enabled: true
    ffmpeg: ffmpeg          # 也可写绝对路径：'D:/tools/ffmpeg/bin/ffmpeg.exe'
    ffprobe: ffprobe
    concurrency: 2          # 同时最多几个 ffmpeg（每个吃满一核）
    timeout_ms: 1800000     # 单文件转码上限 30 分钟，超时杀掉并记失败
    probe_timeout_ms: 15000
    max_queue: 50           # 排队上限，满了让客户端下一轮再问
    max_source_bytes: 0     # 0 = 不限制
    video: { crf: 23, preset: veryfast, audio_bitrate: 128k, max_height: 0 }
    audio: { bitrate: 192k }
```

### 验证

```bash
cd server && npm run test:transcode      # 137 项，自包含（临时配置 + 临时库 + 隔离端口）
```

回归用**本机 ffmpeg 现场生成**素材（mp4 / webm / mp3 / flac / mkv / avi / wma / HEVC-in-mp4 /
文本冒充 mp4），逐个断言「该不该转、副本的编码对不对、原件有没有被动过、副本能不能拖进度条、
重复查询会不会重复转码」，外加商城试看与四种路径/鉴权边界；前端那套播放状态机是纯函数
（`client/src/utils/mediaPlayback.js`），也在同一支回归里逐条钉住。
另有临时 UI 回归（无头 Edge 渲染真实 `MessageBubble`，17 项）：原生 mp4 直出播放器、
avi 从「转码占位」自动换成可播副本且真的解出画面、假 mp4 退回卡片、wma 换成音频播放条。

## 配置项（`server/config.yaml`）

```yaml
security:
  apikey: { prefix_len: 12, secret_len: 40, max_per_user: 10, ip_binding: true }
uploads:
  subdirs: { custom: custom, tmp: tmp }
  limits:  { asset: 524288000 }
static:
  expose: [avatars, files, covers, custom]
business:
  shop:
    categories: [goods, background, bubble, sticker_pack]
    price: { min: 0, max: 100000 }
    grant_assets: true
  assets:       { quota_bytes: 0, batch_max_bytes: 524288000, max_files_per_request: 50, allowed_ext: [...], allowed_mime: [...] }   # quota 0 = 不限总量
  stickers:     { max_packs_per_user: 30, max_items_per_pack: 200, name_max_len: 30, description_max_len: 200, share_code_len: 10 }
  preferences:  { background_max_len: 500, bubble_max_len: 4000, font_size: { min: 12, max: 20 }, max_rooms: 200 }
rate_limits:
  apikey: { window_ms: 60000, max: 600 }
  preview: { window_ms: 60000, max: 60 }   # 商品试看限流（与 download 分开计数）
media:
  transcode: { enabled: true, ffmpeg: ffmpeg, ffprobe: ffprobe, concurrency: 2, timeout_ms: 1800000,
               max_queue: 50, max_source_bytes: 0, video: { crf: 23, preset: veryfast, audio_bitrate: 128k, max_height: 0 },
               audio: { bitrate: 192k } }   # 本地 ffmpeg 转码，见 §九
roles:
  capabilities: { manage_apikeys: 50, manage_public_room: 100 }   # 改公共聊天图标＝仅开发者
```

---

## 验证

后端内置两套端到端自检（需先启动服务）：

```bash
cd server
npm start                      # 另开一个终端
npm run test:api               # 139 项断言：五大功能 + 权限/越权/边界
```

```bash
cd client                      # socket 自检从 client 目录运行，才能解析 socket.io-client
node ../server/scripts/socket_check.mjs   # 46 项断言：消息 / 表情 / 好友 / 群聊 / 密钥通道实时能力
```

```bash
cd server                      # 以下套件自包含（临时配置 + 临时空库 + 隔离端口），不需要先起服务
npm run test:transcode         # 137 项：音视频转码（§九）
npm run test:formats           #  25 项：上传格式白名单
npm run test:file-types        #  15 项：文件类型表
npm run test:security          #  29 项：安全控制
npm run test:static            #  20 项：单端口托管
npm run test:image             #  15 项：前端图片规范化（无头 Edge）
```

需要先起服务的两套（`test:api` / `test:socket`）结束时会自动释放本机 IP 绑定，可重复执行，
不影响后续本地开发。

前端构建：

```bash
cd client && npm run build
```

---

## 明确不做

多客户端架构、前端插槽、远程 UI 加载、主题市场社区化（评分 / 评论 / 关注 / 推荐 / 创作者主页）。
