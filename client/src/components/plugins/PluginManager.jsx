// client/src/components/plugins/PluginManager.jsx
//
// 插件"小程序"主页：宫格 + 右键菜单。
//
// 【交互约定】
//   · 左键单击 → 已安装直接打开；未安装先弹权限对话框（用户确认后自动打开）
//   · 右键单击 → 弹出上下文菜单（项目根据角色 / 状态 / 归属动态生成）
//   · 已下架 / 已隐藏 → 灰化 + 角标，单击无效；管理员可右键恢复
//
// 【图标】
//   · 作者上传插件时可附带一张图片作为图标（iconUrl）
//   · 没配图标就回落到"名称首字"（与 Avatar 组件一致的方形圆角风格）
//
// [CHANGED] 认证改造：不再接收 token prop。
//
// [CHANGED] UI 改造：从"卡片 + 每张卡一排按钮"改为"宫格 + 右键菜单"。
//   · 新类名一律用 plg-mini-* 前缀，避免与旧 PluginManager 的
//     plg-page / plg-grid / plg-card 系列样式冲突（旧的仍留在 plugins.css
//     里作为历史 / 回退，本组件不再使用它们）。
//   · 所有写操作（卸载 / 分享 / 删除 / 下架 / 恢复）从卡片按钮移到右键菜单。
//
// [FIX] 支持 initialScope：SideNav 的「已安装 / 发现 / 我发布的」三个入口
//   之前点进去都停在 'all' —— 因为 ChatRoom.openView 里没有处理 plugins
//   那一支，本组件也没有接收这个 prop。现在两端都补上：
//   ChatRoom.openView('plugins', { scope }) → setPluginScope(scope)
//   → <PluginManager initialScope={pluginScope} /> → useState 初值生效。
//   （viewNonce 递增会让这层 <section> 整体重挂载，所以初值每次都会生效）
//
import { useEffect, useMemo, useState } from 'react';
import {
  listPlugins,
  uninstallPlugin,
  sharePlugin,
  setPluginPrivate,
  subscribePlugin,
  deletePlugin,
  delistPlugin,
  adminRestorePlugin
} from '../../api';
import ContextMenu from '../common/ContextMenu';
import PluginInstallDialog from './PluginInstallDialog';
import PluginUploadDialog from './PluginUploadDialog';
import PluginDetailDialog from './PluginDetailDialog';

const TABS = [
  { key: 'all',       label: '发现' },
  { key: 'installed', label: '我的' },
  { key: 'mine',      label: '我发布的' }
];

export default function PluginManager({
  role,
  // [FIX] SideNav 三个入口通过 openView 的 opts.scope 传进来
  // （'all' | 'installed' | 'mine'）；缺省 'all' 保持向后兼容。
  initialScope,
  onOpenPlugin,
  onError
}) {
  const [tab, setTab] = useState(initialScope || 'all');
  const [keyword, setKeyword] = useState('');
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(false);

  // 未安装时先弹权限框；装好后自动打开目标（"下载后进入"）
  const [installTarget, setInstallTarget] = useState(null);

  // "详情"弹窗的目标
  const [detailTarget, setDetailTarget] = useState(null);

  // 上传对话框
  const [uploadOpen, setUploadOpen] = useState(false);

  // 订阅分享码
  const [subscribeCode, setSubscribeCode] = useState('');
  const [subscribeMsg, setSubscribeMsg] = useState('');

  // 右键菜单：{ x, y, plugin }
  const [menu, setMenu] = useState(null);

  const isAdmin = ['developer', 'super_admin', 'admin'].includes(role);

  // ---------- 数据 ----------
  const load = async () => {
    setLoading(true);
    try {
      const d = await listPlugins({ scope: tab, keyword: keyword.trim() });
      setPlugins(d.plugins || []);
    } catch (err) {
      onError?.(err.message || '加载失败');
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const doSearch = () => load();

  // ---------- 左键单击：智能判断 ----------
  const handleLaunch = (p) => {
    if (p.status !== 'active') {
      alert(p.status === 'delisted' ? '该插件已被下架' : '该插件已被隐藏');
      return;
    }
    if (p.installed) {
      // 已安装：直接打开，不弹任何框
      onOpenPlugin?.(p.id);
    } else {
      // 未安装：弹权限对话框；装好后 onInstallDone 里自动打开
      setInstallTarget(p);
    }
  };

  const onInstallDone = () => {
    const target = installTarget;
    setInstallTarget(null);
    load();
    // "下载后进入" —— 装完直接进入插件
    if (target) onOpenPlugin?.(target.id);
  };

  // ---------- 右键：打开上下文菜单 ----------
  const handleContextMenu = (e, p) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, plugin: p });
  };

  // ---------- 菜单项（根据角色 / 状态 / 归属动态生成） ----------
  const buildMenuItems = (p) => {
    const items = [];

    // 已下架 / 已隐藏：管理员可恢复，其他人无操作
    if (p.status !== 'active') {
      if (isAdmin) {
        items.push({
          label: p.status === 'delisted' ? '恢复上架' : '取消隐藏',
          onClick: () => handleRestore(p)
        });
        if (!p.isOwner) {
          items.push({ divider: true });
          items.push({
            label: '彻底下架',
            danger: true,
            onClick: () => handleDelist(p)
          });
        }
      } else {
        items.push({ label: '（已下架）', onClick: () => {} });
      }
      return items;
    }

    // 主操作
    if (p.installed) {
      items.push({ label: '打开', onClick: () => onOpenPlugin?.(p.id) });
    } else {
      items.push({
        label: '下载并打开',
        onClick: () => setInstallTarget(p)
      });
    }

    // 详情
    items.push({ divider: true });
    items.push({ label: '详情', onClick: () => setDetailTarget(p) });

    // 作者操作
    if (p.isOwner) {
      items.push({ divider: true });
      if (p.isPublic && p.shareCode) {
        items.push({
          label: '复制分享码',
          onClick: () => copyShareCode(p.shareCode)
        });
        items.push({
          label: '重新生成分享码',
          onClick: () => handleShare(p, true)
        });
        items.push({
          label: '停止公开',
          onClick: () => handleSetPrivate(p)
        });
      } else {
        items.push({
          label: '生成分享码',
          onClick: () => handleShare(p, false)
        });
      }
      items.push({
        label: '删除',
        danger: true,
        onClick: () => handleDelete(p)
      });
    }

    // 已安装但非作者：可卸载
    if (p.installed && !p.isOwner) {
      items.push({ divider: true });
      items.push({
        label: '卸载',
        danger: true,
        onClick: () => handleUninstall(p)
      });
    }

    // 管理员对他人插件：可下架
    if (isAdmin && !p.isOwner) {
      items.push({ divider: true });
      items.push({
        label: '下架',
        danger: true,
        onClick: () => handleDelist(p)
      });
    }

    return items;
  };

  // ---------- 具体操作 ----------
  const handleUninstall = async (p) => {
    if (!confirm(`确定卸载「${p.name}」？\n卸载会清掉你在该插件下的所有保存数据。`)) return;
    try {
      await uninstallPlugin(p.id);
      load();
    } catch (err) {
      alert(err.message || '卸载失败');
    }
  };

  const handleShare = async (p, regenerate = false) => {
    try {
      const out = await sharePlugin(p.id, regenerate);
      await copyShareCode(out.shareCode);
      load();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  const copyShareCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      alert(`分享码：${code}\n（已复制到剪贴板）`);
    } catch {
      alert(`分享码：${code}\n（复制失败，请手动复制）`);
    }
  };

  const handleSetPrivate = async (p) => {
    if (!confirm(`停止公开「${p.name}」？`)) return;
    try {
      await setPluginPrivate(p.id);
      load();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  const handleDelete = async (p) => {
    if (!confirm(`确定删除「${p.name}」？\n所有安装了它的用户会失去访问；该操作不可恢复。`)) return;
    try {
      await deletePlugin(p.id);
      load();
    } catch (err) {
      alert(err.message || '删除失败');
    }
  };

  const handleDelist = async (p) => {
    const reason = prompt(`下架「${p.name}」的原因：`);
    if (reason === null) return;
    try {
      await delistPlugin(p.id, reason || '管理员下架');
      load();
    } catch (err) {
      alert(err.message || '下架失败');
    }
  };

  const handleRestore = async (p) => {
    if (!confirm(`恢复「${p.name}」为正常状态？`)) return;
    try {
      await adminRestorePlugin(p.id);
      load();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  // ---------- 订阅分享码 ----------
  const handleSubscribe = async () => {
    const code = subscribeCode.trim();
    if (!code) return;
    setSubscribeMsg('');
    try {
      await subscribePlugin(code);
      setSubscribeCode('');
      setSubscribeMsg('订阅成功');
      setTab('installed');
      load();
    } catch (err) {
      setSubscribeMsg(err.message || '订阅失败');
    }
  };

  const visible = useMemo(() => plugins, [plugins]);

  return (
    <div className="plg-mini">
      {/* ================= 顶部：Tabs / 搜索 / 上传 ================= */}
      <div className="plg-mini-head">
        <div className="plg-mini-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`plg-mini-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="plg-mini-search">
          <input
            className="plg-mini-search-input"
            placeholder="搜索小程序…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
          />
          <button className="plg-mini-search-btn" onClick={doSearch} title="搜索">
            <svg viewBox="0 0 24 24" width="15" height="15"
                 fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.34-4.34" />
            </svg>
          </button>
        </div>

        <button className="plg-mini-upload" onClick={() => setUploadOpen(true)}>
          + 上传
        </button>
      </div>

      {/* ================= 订阅分享码行 ================= */}
      <div className="plg-mini-subscribe">
        <input
          className="plg-mini-subscribe-input"
          value={subscribeCode}
          onChange={(e) => setSubscribeCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubscribe(); }}
          placeholder="输入分享码订阅（PLG-XXXXXXXX）"
        />
        <button className="plg-mini-subscribe-btn" onClick={handleSubscribe}>
          订阅
        </button>
        {subscribeMsg && <span className="plg-mini-subscribe-msg">{subscribeMsg}</span>}
      </div>

      {/* ================= 宫格 ================= */}
      <div className="plg-mini-body">
        {loading && <div className="modal-empty">加载中…</div>}
        {!loading && visible.length === 0 && (
          <div className="plg-mini-empty">
            <div className="plg-mini-empty-icon">◎</div>
            <div className="plg-mini-empty-title">
              {tab === 'installed' ? '还没有安装任何小程序' : '暂无小程序'}
            </div>
            <div className="plg-mini-empty-desc">
              {tab === 'installed'
                ? '去「发现」看看，或输入分享码订阅'
                : '点右上角「+ 上传」发布你自己的小程序'}
            </div>
          </div>
        )}

        {!loading && visible.length > 0 && (
          <div className="plg-mini-grid">
            {visible.map((p) => (
              <button
                key={p.id}
                type="button"
                className={
                  'plg-mini-cell'
                  + (p.status !== 'active' ? ' is-released' : '')
                  + (p.installed ? ' is-installed' : '')
                }
                onClick={() => handleLaunch(p)}
                onContextMenu={(e) => handleContextMenu(e, p)}
                title={`${p.name}${p.description ? ' · ' + p.description : ''}\n右键查看更多`}
              >
                <span className="plg-mini-cell-icon">
                  {p.iconUrl
                    ? <img src={p.iconUrl} alt="" loading="lazy" />
                    : <span className="plg-mini-cell-letter">{(p.name || '?').slice(0, 1)}</span>}

                  {/* 未安装：右下角下载小角标 */}
                  {!p.installed && p.status === 'active' && (
                    <span className="plg-mini-cell-dl" aria-label="未安装">
                      <svg viewBox="0 0 24 24" width="11" height="11"
                           fill="none" stroke="currentColor" strokeWidth="3"
                           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 4v12" />
                        <path d="m6 12 6 6 6-6" />
                      </svg>
                    </span>
                  )}

                  {/* 已下架/隐藏：右上角状态角标 */}
                  {p.status !== 'active' && (
                    <span className={`plg-mini-cell-badge plg-mini-cell-badge--${p.status}`}>
                      {p.status === 'delisted' ? '下架' : '隐藏'}
                    </span>
                  )}

                  {/* 自己的插件：左上角小圆点 */}
                  {p.isOwner && (
                    <span className="plg-mini-cell-own" aria-label="我发布的" />
                  )}
                </span>

                <span className="plg-mini-cell-name" title={p.name}>{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ================= 右键菜单 ================= */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.plugin)}
          onClose={() => setMenu(null)}
        />
      )}

      {/* ================= 安装对话框（权限确认） ================= */}
      {installTarget && (
        <PluginInstallDialog
          plugin={installTarget}
          onClose={() => setInstallTarget(null)}
          onInstalled={onInstallDone}
        />
      )}

      {/* ================= 详情对话框 ================= */}
      {detailTarget && (
        <PluginDetailDialog
          plugin={detailTarget}
          isAdmin={isAdmin}
          onClose={() => setDetailTarget(null)}
          onLaunch={() => {
            const p = detailTarget;
            setDetailTarget(null);
            handleLaunch(p);
          }}
        />
      )}

      {/* ================= 上传对话框 ================= */}
      {uploadOpen && (
        <PluginUploadDialog
          role={role}
          onClose={() => { setUploadOpen(false); }}
          onUploaded={() => { setUploadOpen(false); load(); }}
        />
      )}
    </div>
  );
}