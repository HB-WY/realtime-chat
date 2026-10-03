// client/src/components/nav/SideNav.jsx
//
// 左侧统一导航。
//
// 【本次改动】在"功能"分组加一个「插件」入口：
//   · 点击展开 flyout，列出：
//       插件管理（全部 / 已安装 / 我发布的）
//       我的支付（我付给插件的）
//       我的收款（我作为作者收到的）
//   · view 为 'plugins' / 'plugin' 时高亮
//
import { useCallback, useEffect, useRef, useState } from 'react';
import Avatar from '../common/Avatar';
import Icon from '../common/Icon';
import { roomPreview } from '../../utils/room';

// 移开后的收起延迟：给鼠标在导航项与飞出面板之间移动留时间
const CLOSE_DELAY = 160;

const MARKETS = [
  { key: 'official', label: '官方市场', icon: 'shop' },
  { key: 'standard', label: '标准市场', icon: 'package' },
  { key: 'flea', label: '跳蚤市场', icon: 'shop' },
  { key: 'mine', label: '我发布的', icon: 'package' },
  { key: 'orders', label: '我的订单', icon: 'receipt' }
];

export default function SideNav({
  view, tab, user, role, connected, onlineUsers,
  rooms, friends, groups, receivedFriendReqs, pendingGroupReqs,
  canOpenAdmin, canRequestPromotion, canManagePublicRoom, adminTabs = [],
  onSelectTab, onOpenView, onOpenRoom, onOpenPrivateChat, onOpenGroupChat,
  onOpenPublicRoomIcon, onLogout
}) {
  const [expanded, setExpanded] = useState(false);
  const [flyout, setFlyout] = useState(null); // { key, top }
  const [logoOk, setLogoOk] = useState(true);
  const railRef = useRef(null);
  const timer = useRef(null);
  const [canHover] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches
  );

  const unread = rooms.reduce((n, r) => n + (r.unread || 0), 0);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const openRail = useCallback(() => {
    clearTimer();
    if (canHover) setExpanded(true);
  }, [canHover, clearTimer]);

  const closeRail = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => {
      setExpanded(false);
      setFlyout(null);
    }, CLOSE_DELAY);
  }, [clearTimer]);

  const closeNow = useCallback(() => {
    clearTimer();
    setExpanded(false);
    setFlyout(null);
  }, [clearTimer]);

  // 悬停到某一项：在它旁边（触屏时贴边）展开它的子功能。
  // 靠近底部时改为「向上展开」，避免面板越出视口。
  const openFlyout = useCallback(
    (key, el) => {
      clearTimer();
      if (!canHover) {
        setFlyout({ key });
        return;
      }
      const rail = railRef.current?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const railH = rail ? rail.height : window.innerHeight;
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      const up = spaceBelow < 380 && spaceAbove > spaceBelow;
      setFlyout({
        key,
        up,
        top: rail ? Math.round(r.top - rail.top) : 0,
        bottom: Math.round(railH - (r.bottom - (rail ? rail.top : 0)))
      });
    },
    [canHover, clearTimer]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') closeNow();
    };
    const onDown = (e) => {
      if (railRef.current && !railRef.current.contains(e.target)) closeNow();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      clearTimer();
    };
  }, [closeNow, clearTimer]);

  // 鼠标设备：悬停展开、点击进入；触屏：先点开子功能，再点进入
  const clickItem = (item, e) => {
    if (!canHover && item.flyout) {
      if (flyout?.key === item.key) {
        closeNow();
        item.primary();
      } else {
        openFlyout(item.key, e.currentTarget);
      }
      return;
    }
    closeNow();
    item.primary();
  };

  const hoverItem = (item) => (e) => {
    if (!canHover) return;
    if (item.flyout) openFlyout(item.key, e.currentTarget);
    else {
      clearTimer();
      setFlyout(null);
    }
  };

  const go = (fn) => () => {
    closeNow();
    fn();
  };

  const items = {
    messages: {
      key: 'messages',
      icon: 'message',
      label: '消息',
      primaryLabel: '进入消息中心',
      badge: unread,
      active: view === 'chat' && tab === 'messages',
      primary: () => onSelectTab('messages'),
      flyout: <MessagesFlyout rooms={rooms} meId={user.id} onOpen={onOpenRoom} go={go} />
    },
    contacts: {
      key: 'contacts',
      icon: 'user',
      label: '联系人',
      primaryLabel: '打开联系人',
      badge: receivedFriendReqs.length,
      active: view === 'chat' && tab === 'contacts',
      primary: () => onSelectTab('contacts'),
      flyout: (
        <ContactsFlyout
          friends={friends}
          requests={receivedFriendReqs}
          onlineUsers={onlineUsers}
          go={go}
          onOpenView={onOpenView}
          onSelectTab={onSelectTab}
          onOpenChat={onOpenPrivateChat}
        />
      )
    },
    groups: {
      key: 'groups',
      icon: 'users',
      label: '群聊',
      primaryLabel: '打开群聊',
      badge: pendingGroupReqs.length,
      active: view === 'chat' && tab === 'groups',
      primary: () => onSelectTab('groups'),
      flyout: (
        <GroupsFlyout
          groups={groups}
          requests={pendingGroupReqs}
          go={go}
          onOpenView={onOpenView}
          onSelectTab={onSelectTab}
          onOpenChat={onOpenGroupChat}
        />
      )
    },
    shop: {
      key: 'shop',
      icon: 'shop',
      label: '商城',
      primaryLabel: '进入商城',
      active: view === 'shop',
      primary: () => onOpenView('shop'),
      flyout: (
        <div className="nav-list">
          <div className="nav-title">商城</div>
          {MARKETS.map((m) => (
            <button
              key={m.key}
              className="nav-row"
              onClick={go(() => onOpenView('shop', { shopTab: m.key }))}
            >
              <Icon name={m.icon} size={18} />
              <span>{m.label}</span>
            </button>
          ))}
        </div>
      )
    },
    assets: {
      key: 'assets',
      icon: 'palette',
      label: '素材',
      primaryLabel: '打开外观设置',
      active: ['appearance', 'assets', 'stickers'].includes(view),
      primary: () => onOpenView('appearance'),
      flyout: (
        <div className="nav-list">
          <div className="nav-title">外观与素材</div>
          <button className="nav-row" onClick={go(() => onOpenView('appearance'))}>
            <Icon name="palette" size={18} />
            <span>外观设置</span>
            <small>背景 / 气泡 / 字号</small>
          </button>
          <button className="nav-row" onClick={go(() => onOpenView('assets'))}>
            <Icon name="images" size={18} />
            <span>我的资源</span>
            <small>上传与配额</small>
          </button>
          <button className="nav-row" onClick={go(() => onOpenView('stickers'))}>
            <Icon name="smile" size={18} />
            <span>表情包</span>
            <small>制作 / 订阅</small>
          </button>
          {canManagePublicRoom && (
            <button className="nav-row" onClick={go(onOpenPublicRoomIcon)}>
              <Icon name="image" size={18} />
              <span>公共聊天图标</span>
              <small>开发者</small>
            </button>
          )}
        </div>
      )
    },
    // [NEW] 插件入口
    plugins: {
      key: 'plugins',
      icon: 'package',
      label: '插件',
      primaryLabel: '打开插件管理',
      // view 为 'plugins'（管理页）或 'plugin'（运行某一个）时高亮
      active: ['plugins', 'plugin'].includes(view),
      primary: () => onOpenView('plugins'),
      flyout: (
        <div className="nav-list">
          <div className="nav-title">插件</div>
          <button className="nav-row" onClick={go(() => onOpenView('plugins', { scope: 'installed' }))}>
            <Icon name="package" size={18} />
            <span>已安装</span>
            <small>打开 / 卸载</small>
          </button>
          <button className="nav-row" onClick={go(() => onOpenView('plugins'))}>
            <Icon name="search" size={18} />
            <span>发现插件</span>
            <small>搜索 / 订阅</small>
          </button>
          <button className="nav-row" onClick={go(() => onOpenView('plugins', { scope: 'mine' }))}>
            <Icon name="user" size={18} />
            <span>我发布的</span>
            <small>上传 / 管理</small>
          </button>
          <button className="nav-row" onClick={go(() => onOpenView('points'))}>
            <Icon name="receipt" size={18} />
            <span>积分流水</span>
            <small>含插件支付</small>
          </button>
        </div>
      )
    }
  };

  if (canOpenAdmin && adminTabs.length > 0) {
    items.admin = {
      key: 'admin',
      icon: 'shield',
      label: '管理',
      primaryLabel: '打开管理面板',
      active: view === 'admin',
      primary: () => onOpenView('admin'),
      flyout: (
        <div className="nav-list">
          <div className="nav-title">管理后台</div>
          {adminTabs.map((t) => (
            <button
              key={t.key}
              className="nav-row"
              onClick={go(() => onOpenView('admin', { adminTab: t.key }))}
            >
              <Icon name={t.icon || 'shield'} size={18} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )
    };
  }

  const account = {
    key: 'account',
    icon: 'user',
    label: '账户',
    avatar: true,
    primaryLabel: '打开个人资料',
    active: ['profile', 'points', 'apikeys', 'promote'].includes(view),
    primary: () => onOpenView('profile'),
    flyout: (
      <div className="nav-list">
        <div className="nav-title">
          <Avatar name={user.nickname} avatar={user.avatar} size={24} />
          {user.nickname}
          {role !== 'user' && <span className={`role-tag role-${role}`}>{roleLabel(role)}</span>}
        </div>
        <button className="nav-row" onClick={go(() => onOpenView('profile'))}>
          <Icon name="profile" size={18} />
          <span>个人信息</span>
        </button>
        <button className="nav-row" onClick={go(() => onOpenView('points'))}>
          <Icon name="gem" size={18} />
          <span>积分流水</span>
        </button>
        <button className="nav-row" onClick={go(() => onOpenView('apikeys'))}>
          <Icon name="key" size={18} />
          <span>API 密钥</span>
        </button>
        {canRequestPromotion && (
          <button className="nav-row" onClick={go(() => onOpenView('promote'))}>
            <Icon name="promote" size={18} />
            <span>升职申请</span>
          </button>
        )}
        <div className="nav-sep" />
        <button className="nav-row is-danger" onClick={go(onLogout)}>
          <Icon name="logout" size={18} />
          <span>退出登录</span>
        </button>
      </div>
    )
  };

  // [NEW] 功能分组里加"插件"
  const navGroups = [
    { title: '会话', items: [items.messages, items.contacts, items.groups] },
    {
      title: '功能',
      items: [
        items.shop,
        items.assets,
        items.plugins,
        ...(items.admin ? [items.admin] : [])
      ]
    }
  ];

  const renderItem = (item) => (
    <button
      key={item.key}
      type="button"
      className={`nav-item${item.active ? ' is-active' : ''}`}
      onClick={(e) => clickItem(item, e)}
      onMouseEnter={hoverItem(item)}
      title={item.label}
      aria-current={item.active ? 'page' : undefined}
      aria-expanded={flyout?.key === item.key}
    >
      {item.avatar ? (
        <Avatar name={user.nickname} avatar={user.avatar} size={22} />
      ) : (
        <Icon name={item.icon} size={20} />
      )}
      <span className="nav-text">{item.label}</span>
      {item.badge > 0 && (
        <b className="nav-badge">{item.badge > 99 ? '99+' : item.badge}</b>
      )}
    </button>
  );

  const allItems = [...navGroups[0].items, ...navGroups[1].items, account];
  const active = flyout ? allItems.find((i) => i.key === flyout.key) : null;

  return (
    <aside
      className={`sidenav${expanded ? ' is-open' : ''}`}
      ref={railRef}
      onMouseEnter={openRail}
      onMouseLeave={closeRail}
    >
      <div className="sidenav-head">
        {/* 品牌图标：public/logo.jpg（加载失败时回落到字符，不出现裂图） */}
        <span className="sidenav-logo">
          {logoOk ? (
            <img
              src="/logo.jpg"
              alt="聊天系统"
              onError={() => setLogoOk(false)}
            />
          ) : (
            '聊'
          )}
        </span>
        <strong className="sidenav-name">聊天系统</strong>
      </div>

      <div className="sidenav-body">
        {navGroups.map((g) => (
          <div className="nav-group" key={g.title}>
            <div className="nav-caption">{g.title}</div>
            {g.items.map(renderItem)}
          </div>
        ))}
      </div>

      <div className="sidenav-foot">
        <div className="nav-group">{renderItem(account)}</div>
        <div className="nav-caption nav-online" title={`在线 ${onlineUsers.length} 人`}>
          <span className={`dot ${connected ? 'online' : 'offline'}`} />
          <span>{connected ? `在线 · ${onlineUsers.length}` : '未连接'}</span>
        </div>
      </div>

      {/* 子功能面板：鼠标设备浮在导航项右侧，触屏贴边铺开 */}
      {active && (
        <div
          className="nav-flyout"
          style={
            canHover && flyout.top !== undefined
              ? flyout.up
                ? { bottom: flyout.bottom }
                : { top: flyout.top }
              : undefined
          }
        >
          <div className="nav-list">
            <button className="nav-row is-primary" onClick={go(active.primary)}>
              <Icon name={active.icon} size={18} />
              <span>{active.primaryLabel || active.label}</span>
            </button>
          </div>
          {active.flyout}
        </div>
      )}
    </aside>
  );
}

function MessagesFlyout({ rooms, meId, onOpen, go }) {
  const recent = rooms.slice(0, 8);
  return (
    <div className="nav-list">
      <div className="nav-title">最近会话</div>
      {recent.length === 0 && <div className="nav-empty">还没有会话</div>}
      {recent.map((r) => (
        <button key={r.key} className="nav-row" onClick={go(() => onOpen(r))}>
          <Avatar name={r.name} avatar={r.avatar} size={28} />
          <span className="nav-main">
            <strong>{r.name}</strong>
            <small>{roomPreview(r, meId, 14)}</small>
          </span>
          {r.unread > 0 && <b className="nav-badge">{r.unread > 99 ? '99+' : r.unread}</b>}
        </button>
      ))}
    </div>
  );
}

function ContactsFlyout({ friends, requests, onlineUsers, go, onOpenView, onSelectTab, onOpenChat }) {
  const online = new Set(onlineUsers.map((u) => u.id));
  return (
    <div className="nav-list">
      <button className="nav-row" onClick={go(() => onOpenView('addFriend'))}>
        <Icon name="plus" size={18} />
        <span>添加好友</span>
        <small>搜索用户</small>
      </button>

      {requests.length > 0 && (
        <>
          <div className="nav-sep" />
          <div className="nav-title">好友申请 ({requests.length})</div>
          {requests.slice(0, 4).map((r) => (
            <div key={r.id} className="nav-row is-static">
              <Avatar name={r.nickname} avatar={r.avatar} size={28} />
              <span className="nav-main">
                <strong>{r.nickname}</strong>
                <small>@{r.username}</small>
              </span>
            </div>
          ))}
          <button className="nav-row is-link" onClick={go(() => onSelectTab('contacts'))}>
            <span>在联系人里处理</span>
          </button>
        </>
      )}

      <div className="nav-sep" />
      <div className="nav-title">好友 ({friends.length})</div>
      {friends.length === 0 && <div className="nav-empty">还没有好友</div>}
      {friends.slice(0, 6).map((f) => (
        <button key={f.id} className="nav-row" onClick={go(() => onOpenChat(f))}>
          <Avatar name={f.nickname} avatar={f.avatar} size={28} />
          <span className="nav-main">
            <strong>{f.nickname}</strong>
            <small>{online.has(f.id) ? '在线' : '离线'}</small>
          </span>
          {online.has(f.id) && <span className="dot online" />}
        </button>
      ))}
    </div>
  );
}

function GroupsFlyout({ groups, requests, go, onOpenView, onSelectTab, onOpenChat }) {
  return (
    <div className="nav-list">
      <button className="nav-row" onClick={go(() => onOpenView('createGroup'))}>
        <Icon name="plus" size={18} />
        <span>创建群聊</span>
      </button>
      <button className="nav-row" onClick={go(() => onOpenView('joinGroup'))}>
        <Icon name="search" size={18} />
        <span>发现群聊</span>
        <small>搜索并申请</small>
      </button>

      {requests.length > 0 && (
        <>
          <div className="nav-sep" />
          <div className="nav-title">加群申请 ({requests.length})</div>
          {requests.slice(0, 4).map((r) => (
            <div key={r.id} className="nav-row is-static">
              <Avatar name={r.nickname} avatar={r.avatar} size={28} />
              <span className="nav-main">
                <strong>{r.nickname}</strong>
                <small>申请加入「{r.groupName}」</small>
              </span>
            </div>
          ))}
          <button className="nav-row is-link" onClick={go(() => onSelectTab('groups'))}>
            <span>在群聊里处理</span>
          </button>
        </>
      )}

      <div className="nav-sep" />
      <div className="nav-title">我的群 ({groups.length})</div>
      {groups.length === 0 && <div className="nav-empty">还没有加入群聊</div>}
      {groups.slice(0, 6).map((g) => (
        <button key={g.id} className="nav-row" onClick={go(() => onOpenChat(g))}>
          <Avatar name={g.name} avatar={g.avatar} size={28} />
          <span className="nav-main">
            <strong>{g.name}</strong>
            <small>{g.member_count} 人</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function roleLabel(r) {
  return {
    developer: '开发者',
    super_admin: '超级管理员',
    admin: '管理员',
    user: '用户'
  }[r] || r;
}