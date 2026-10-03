// client/src/components/chat/ChatRoom.jsx
//
// 主编排组件。
//
// 【本次改动 · 插件系统 v3 配套】
//   · <PluginManager> 传 socket —— 让它监听 plugin:updated 广播
//     （作者上传新版本时，已安装用户会看到"更新"角标）
//
// 【历史修复】
//   · B1：右键表情消息的「购买表情包」现在通过 /api/stickers/lookup
//     反查出 productId，**直接打开商品详情**。
//   · C1：buildMenuItems 的 useCallback 依赖数组补上 openView 与 token。
//   · B2：<ShopPage> 不再传死 prop `me`；ProductDetailModal 也删掉了 `me`。
//   · openView 支持 opts.scope 转给 PluginManager 的 initialScope
//   · stickerBuyProductId 弹窗里的 ProductDetailModal 也删掉了死 prop `me`
//
// 【新增】支付系统（转账 / 红包）
//
// 【修复】TDZ：openView 定义原先放在 buildMenuItems 之后，而 buildMenuItems
//   的 useCallback 依赖数组里引用了 openView。依赖数组是立即求值的 →
//   ReferenceError，一渲染就崩。这里把 openView 提前到 buildMenuItems 之前。
//
// [CHANGED] 认证改造：不再接收 token prop。
//
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useSocket } from '../../hooks/useSocket';
import { useRole } from '../../hooks/useRole';
import { usePreferences, buildAppearanceStyle } from '../../hooks/usePreferences';
import { privateRoomId } from '../../utils/room';
import { playPing } from '../../utils/sounds';
import { listStickerPacks, lookupSticker } from '../../api';

// 插件相关样式（一次性在入口处 import，确保全局可用）
import '../../styles/plugins.css';

import SideNav from '../nav/SideNav';
import ListPanel from './ListPanel';
import ChatHeader from './ChatHeader';
import MessageList from './MessageList';
import ReplyBar from './ReplyBar';
import TypingIndicator from './TypingIndicator';
import ChatInput from './ChatInput';

import ContextMenu from '../common/ContextMenu';
import ImageLightbox from '../common/ImageLightbox';
// 【新增】点击头像弹出的用户卡片
import UserCardModal from '../common/UserCardModal';
import AvatarEditor from '../auth/AvatarEditor';
import AddFriendModal from '../contacts/AddFriendModal';
import CreateGroupModal from '../contacts/CreateGroupModal';
import JoinGroupModal from '../contacts/JoinGroupModal';
import GroupInfoModal from '../contacts/GroupInfoModal';
import PublicRoomIconModal from '../rooms/PublicRoomIconModal';

import ShopPage from '../shop/ShopPage';
import PointsHistoryModal from '../shop/PointsHistoryModal';
import ProductDetailModal from '../shop/ProductDetailModal';
import RoleRequestModal from '../role/RoleRequestModal';
import AdminPanel from '../admin/AdminPanel';
import adminTabsFor from '../admin/adminTabs';
import AppearanceModal from '../appearance/AppearanceModal';
import StickerPackManager from '../stickers/StickerPackManager';
import AssetLibraryModal from '../assets/AssetLibraryModal';
import ApiKeysModal from '../apikeys/ApiKeysModal';

// 插件系统
import PluginManager from '../plugins/PluginManager';
import PluginHost from '../plugins/PluginHost';
import PluginPayDialog from '../plugins/PluginPayDialog';

// 【新增】支付系统（转账 / 红包）
import TransferDialog from '../payments/TransferDialog';
import RedPacketDialog from '../payments/RedPacketDialog';

/**
 * 【新增】好友常驻消息栏：
 *   把好友列表合并进会话 rooms —— 每个好友对应一个私聊会话，
 *   无论在不在线、有没有聊过天，都固定显示在消息栏里。
 *
 * 规则：
 *   · 已存在的私聊会话：用好友最新资料（昵称/头像/签名）覆盖显示
 *   · 新好友：补建一个「暂无消息」的会话
 *   · 解除好友：没有历史消息的空会话随之移除；有历史消息的保留
 *     （微信行为 —— 聊天记录不该因为删好友而消失）
 */
function mergeFriendRooms(prevRooms, friendList, meId) {
  const friendByKey = new Map();
  for (const f of friendList || []) {
    friendByKey.set(privateRoomId(meId, f.id), f);
  }

  const out = [];
  const seen = new Set();
  for (const r of prevRooms) {
    if (r.type === 'private') {
      const f = friendByKey.get(r.key);
      if (f) {
        out.push({
          ...r,
          name: f.nickname,
          avatar: f.avatar,
          signature: f.signature || ''
        });
        seen.add(r.key);
      } else if (r.lastMessage) {
        // 不是好友但有聊天记录 → 保留会话
        out.push(r);
        seen.add(r.key);
      }
      // 不是好友且没有消息 → 丢弃
    } else {
      out.push(r);
      seen.add(r.key);
    }
  }

  for (const [key, f] of friendByKey) {
    if (!seen.has(key)) {
      out.push({
        key,
        type: 'private',
        roomId: key,
        peerId: f.id,
        name: f.nickname,
        avatar: f.avatar,
        signature: f.signature || '',
        unread: 0,
        lastMessage: null
      });
    }
  }
  return out;
}

export default function ChatRoom({ user, onLogout, onUserUpdate }) {
  const { socket, connected, emit } = useSocket();
  const { role, can, refresh: refreshRole } = useRole();
  const { prefs, setPrefs } = usePreferences();

  // ── 界面路由 ──────────────────────────────────────────
  const [view, setView] = useState('chat');
  const [tab, setTab] = useState('messages');
  const [shopTab, setShopTab] = useState('official');
  const [shopCategory, setShopCategory] = useState('');
  const [adminTab, setAdminTab] = useState('');
  const [viewNonce, setViewNonce] = useState(0);

  // plugins 视图的默认 scope（'all' | 'installed' | 'mine'）。
  const [pluginScope, setPluginScope] = useState('all');

  // 当前打开的插件 id（view === 'plugin' 时有效）
  const [pluginHostId, setPluginHostId] = useState(null);

  // 支付确认框：{ info, resolve }
  const [payDialog, setPayDialog] = useState(null);

  // 【新增】点击头像弹出的用户卡片（目标用户 id）
  const [userCardId, setUserCardId] = useState(null);

  // 当前打开的支付弹窗（转账 / 红包）
  const [transferOpen, setTransferOpen] = useState(false);
  const [redPacketOpen, setRedPacketOpen] = useState(false);

  const [friends, setFriends] = useState([]);
  const [groups, setGroups] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [receivedFriendReqs, setReceivedFriendReqs] = useState([]);
  const [pendingGroupReqs, setPendingGroupReqs] = useState([]);

  const [rooms, setRooms] = useState([
    {
      key: 'public',
      type: 'public',
      roomId: 'public',
      name: '公共聊天',
      avatar: '',
      unread: 0,
      lastMessage: null
    }
  ]);
  const [activeKey, setActiveKey] = useState('public');
  const [messagesByRoom, setMessagesByRoom] = useState({});
  const [typingUsers, setTypingUsers] = useState(new Set());
  const [replyTo, setReplyTo] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  const [draftsByRoom, setDraftsByRoom] = useState({});

  const [groupInfoId, setGroupInfoId] = useState(null);

  // 公共聊天房（图标由开发者在服务端维护，所有人实时同步）
  const [publicRoom, setPublicRoom] = useState(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [unread, setUnread] = useState(0);

  const [lightbox, setLightbox] = useState(null);

  // 表情包被作者 / 订阅关系变更时 +1，让打开中的表情面板重新拉取
  const [stickerRevision, setStickerRevision] = useState(0);

  // 「我拥有 / 订阅的表情包」集合
  const [myStickerPacks, setMyStickerPacks] = useState({});

  // 从表情消息右键点击「购买表情包」时打开的商品详情
  const [stickerBuyProductId, setStickerBuyProductId] = useState(null);

  const virtuosoRef = useRef(null);
  const atBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const friendsRef = useRef(friends);
  const groupsRef = useRef(groups);
  const activeKeyRef = useRef(activeKey);
  const groupInfoIdRef = useRef(groupInfoId);

  useEffect(() => { friendsRef.current = friends; }, [friends]);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  useEffect(() => { activeKeyRef.current = activeKey; }, [activeKey]);
  useEffect(() => { groupInfoIdRef.current = groupInfoId; }, [groupInfoId]);

  // 拉取我的表情包集合
  const refreshMyStickerPacks = useCallback(async () => {
    try {
      const d = await listStickerPacks();
      const map = {};
      for (const p of d.packs || []) map[p.id] = true;
      setMyStickerPacks(map);
    } catch {
      /* 拉不到不影响聊天 */
    }
  }, []);

  useEffect(() => {
    refreshMyStickerPacks();
  }, [refreshMyStickerPacks, stickerRevision]);

  // 公共聊天的名称 / 图标来自服务端，派生时覆盖到会话列表的那一条
  const roomList = useMemo(
    () =>
      publicRoom
        ? rooms.map((r) =>
            r.key === 'public'
              ? { ...r, name: publicRoom.name || r.name, avatar: publicRoom.icon || '' }
              : r
          )
        : rooms,
    [rooms, publicRoom]
  );

  const activeRoom = useMemo(
    () => roomList.find((r) => r.key === activeKey) || roomList[0],
    [roomList, activeKey]
  );
  const messages = useMemo(
    () => messagesByRoom[activeKey] || [],
    [messagesByRoom, activeKey]
  );

  const appearanceStyle = useMemo(
    () => buildAppearanceStyle(prefs, activeKey),
    [prefs, activeKey]
  );

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) 聊天系统` : '聊天系统';
    return () => {
      document.title = '聊天系统';
    };
  }, [unread]);

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) setUnread(0);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // 自己改昵称/头像后，更新私聊房间里的对端显示
  useEffect(() => {
    setRooms((rs) =>
      rs.map((r) => {
        if (r.type === 'private' && r.peerId === user.id) {
          return { ...r, name: user.nickname, avatar: user.avatar };
        }
        return r;
      })
    );
  }, [user.nickname, user.avatar, user.id]);

  // ── Socket 事件 ────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const onInit = (s) => {
      setFriends(s.friends || []);
      setGroups(s.groups || []);
      setReceivedFriendReqs(s.receivedFriendRequests || []);
      setPendingGroupReqs(s.pendingGroupRequests || []);
      if (s.publicRoom) setPublicRoom(s.publicRoom);
      // 【新增】好友常驻消息栏：初始化时把好友合并进会话列表
      setRooms((prev) => mergeFriendRooms(prev, s.friends || [], user.id));
      socket.emit('room:open', { roomType: 'public', roomId: 'public' });
    };

    const onHistory = ({ roomType, roomId, messages: hist }) => {
      const key = roomType === 'public' ? 'public' : roomId;
      setMessagesByRoom((prev) => ({ ...prev, [key]: hist }));
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: Math.max(0, hist.length - 1),
          behavior: 'auto'
        });
      });
    };

    const onNew = (msg) => {
      const key = msg.roomType === 'public' ? 'public' : msg.roomId;

      setRooms((prev) => {
        if (prev.some((r) => r.key === key)) {
          return prev.map((r) =>
            r.key === key ? { ...r, lastMessage: msg } : r
          );
        }
        let newRoom;
        if (msg.roomType === 'private') {
          const parts = msg.roomId.replace(/^p_/, '').split('_').map(Number);
          const peerId = parts[0] === user.id ? parts[1] : parts[0];
          const isFromSelf = msg.senderId === user.id;
          const peer = !isFromSelf
            ? { id: msg.senderId, nickname: msg.senderName, avatar: msg.senderAvatar }
            : null;
          const f = friendsRef.current.find((x) => x.id === peerId);
          newRoom = {
            key,
            type: 'private',
            roomId: msg.roomId,
            peerId,
            name: f?.nickname || peer?.nickname || '陌生人',
            avatar: f?.avatar || peer?.avatar || '',
            unread: 0,
            lastMessage: msg
          };
        } else {
          const gid = Number(msg.roomId.replace(/^g_/, ''));
          const g = groupsRef.current.find((x) => x.id === gid);
          newRoom = {
            key,
            type: 'group',
            roomId: msg.roomId,
            groupId: gid,
            name: g?.name || '群聊',
            avatar: g?.avatar || '',
            unread: 0,
            lastMessage: msg
          };
        }
        return [...prev, newRoom];
      });

      setMessagesByRoom((prev) => {
        const arr = prev[key] || [];
        if (arr.some((m) => m.id === msg.id)) return prev;
        return { ...prev, [key]: [...arr, msg] };
      });

      const isFromOther = msg.senderId !== user.id;
      if (key === activeKeyRef.current && atBottomRef.current && !document.hidden) {
        requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
        });
      } else if (key !== activeKeyRef.current) {
        setRooms((prev) =>
          prev.map((r) =>
            r.key === key ? { ...r, unread: (r.unread || 0) + 1 } : r
          )
        );
      }

      if (isFromOther && (document.hidden || key !== activeKeyRef.current)) {
        playPing();
        if (document.hidden) setUnread((n) => n + 1);
      }
    };

    const onSystem = (sys) => {
      const key = sys.roomType === 'public' ? 'public' : sys.roomId;
      const m = {
        ...sys,
        type: 'system',
        id: 'sys_' + Math.random().toString(36).slice(2, 9)
      };
      setMessagesByRoom((prev) => ({
        ...prev,
        [key]: [...(prev[key] || []), m]
      }));
    };

    const onOnline = (list) => setOnlineUsers(list);

    const onTyping = ({ roomType, roomId, userId, nickname, isTyping }) => {
      if (userId === user.id) return;
      const key = roomType === 'public' ? 'public' : roomId;
      if (key !== activeKeyRef.current) return;
      setTypingUsers((prev) => {
        const n = new Set(prev);
        if (isTyping) n.add(nickname);
        else n.delete(nickname);
        return n;
      });
    };

    const onRead = ({ messageId, userId: readerId }) => {
      setMessagesByRoom((prev) => {
        const out = {};
        for (const k in prev) {
          out[k] = prev[k].map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  readBy: Array.from(new Set([...(m.readBy || []), readerId]))
                }
              : m
          );
        }
        return out;
      });
    };

    const onRecalled = ({ messageId }) => {
      setMessagesByRoom((prev) => {
        const out = {};
        for (const k in prev) {
          out[k] = prev[k].filter((m) => m.id !== messageId);
        }
        return out;
      });
    };

    const onUserUpdated = (u) => {
      setMessagesByRoom((prev) => {
        const out = {};
        for (const k in prev) {
          out[k] = prev[k].map((m) =>
            m.senderId === u.id
              ? { ...m, senderName: u.nickname, senderAvatar: u.avatar }
              : m
          );
        }
        return out;
      });
      setOnlineUsers((prev) =>
        prev.map((x) =>
          x.id === u.id ? { ...x, nickname: u.nickname, avatar: u.avatar } : x
        )
      );
      setFriends((prev) =>
        prev.map((f) =>
          f.id === u.id
            ? {
                ...f,
                nickname: u.nickname,
                avatar: u.avatar,
                // 【新增】签名同步（user:updated 广播带 signature）
                ...(u.signature !== undefined ? { signature: u.signature } : {})
              }
            : f
        )
      );
      setRooms((prev) =>
        prev.map((r) =>
          r.type === 'private' && r.peerId === u.id
            ? {
                ...r,
                name: u.nickname,
                avatar: u.avatar,
                ...(u.signature !== undefined ? { signature: u.signature } : {})
              }
            : r
        )
      );
      if (u.id === user.id) refreshRole();
    };

    const onFriendReqNew = (req) =>
      setReceivedFriendReqs((prev) => [req, ...prev]);

    const onFriendList = (list) => {
      setFriends(list);
      // 【新增】好友常驻消息栏：加好友 → 补建会话；删好友 → 移除空会话
      setRooms((prev) => mergeFriendRooms(prev, list, user.id));
    };

    const onFriendAccepted = ({ byId }) => {
      setReceivedFriendReqs((prev) => prev.filter((r) => r.fromId !== byId));
    };

    const onGroupList = (list) => {
      setGroups(list);
      setRooms((prev) =>
        prev.map((r) => {
          if (r.type === 'group') {
            const g = list.find((x) => x.id === r.groupId);
            if (g) return { ...r, name: g.name, avatar: g.avatar };
          }
          return r;
        })
      );
    };

    const onGroupReqNew = (req) => setPendingGroupReqs((prev) => [req, ...prev]);

    const onGroupUpdated = ({ groupId }) => {
      if (groupInfoIdRef.current === groupId) {
        socket.emit('group:info', { groupId }, () => {});
      }
    };

    const onGroupRemoved = ({ groupId }) => {
      setGroups((prev) => prev.filter((g) => g.id !== groupId));
      setRooms((prev) =>
        prev.filter((r) => !(r.type === 'group' && r.groupId === groupId))
      );
    };

    const onPublicRoomUpdated = (room) => setPublicRoom(room);

    // 【新增】收到新红包：构造一条 msg（与 backend loadHistory 的格式一致）
    const onRedPacketNew = (payload = {}) => {
      const rp = payload.redPacket;
      if (!rp || !payload.messageId) return;
      const sender = payload.sender || {};
      const msg = {
        id: payload.messageId,
        roomType: rp.roomType,
        roomId: rp.roomId,
        senderId: rp.senderId,
        senderName: sender.nickname || '有人',
        senderAvatar: sender.avatar || '',
        text: '',
        refType: 'red_packet',
        refId: rp.id,
        createdAt: rp.createdAt,
        readBy: []
      };
      // 复用 onNew 的逻辑（含未读/提示音/滚动）
      onNew(msg);
    };

    // 【新增】收到新转账：同上
    const onTransferNew = (payload = {}) => {
      const tr = payload.transfer;
      if (!tr || !payload.messageId) return;
      const from = payload.fromUser || {};
      const roomId = `p_${Math.min(tr.fromId, tr.toId)}_${Math.max(tr.fromId, tr.toId)}`;
      const msg = {
        id: payload.messageId,
        roomType: 'private',
        roomId,
        senderId: tr.fromId,
        senderName: from.nickname || '有人',
        senderAvatar: from.avatar || '',
        text: '',
        refType: 'transfer',
        refId: tr.id,
        createdAt: tr.createdAt,
        readBy: []
      };
      onNew(msg);
    };

    socket.on('state:init', onInit);
    socket.on('messages:history', onHistory);
    socket.on('message:new', onNew);
    socket.on('message:system', onSystem);
    socket.on('users:online', onOnline);
    socket.on('typing:update', onTyping);
    socket.on('message:read', onRead);
    socket.on('message:recalled', onRecalled);
    socket.on('user:updated', onUserUpdated);

    socket.on('friend:req:new', onFriendReqNew);
    socket.on('friend:list', onFriendList);
    socket.on('friend:req:accepted', onFriendAccepted);

    socket.on('group:list', onGroupList);
    socket.on('group:req:new', onGroupReqNew);
    socket.on('group:updated', onGroupUpdated);
    socket.on('group:removed', onGroupRemoved);
    socket.on('room:public:updated', onPublicRoomUpdated);

    // 【新增】支付系统事件
    socket.on('redpacket:new', onRedPacketNew);
    socket.on('transfer:new', onTransferNew);

    const onStickerChanged = () => setStickerRevision((v) => v + 1);
    socket.on('stickers:pack:updated', onStickerChanged);
    socket.on('stickers:pack:removed', onStickerChanged);
    socket.on('stickers:pack:subscribed', onStickerChanged);

    return () => {
      socket.off('state:init', onInit);
      socket.off('messages:history', onHistory);
      socket.off('message:new', onNew);
      socket.off('message:system', onSystem);
      socket.off('users:online', onOnline);
      socket.off('typing:update', onTyping);
      socket.off('message:read', onRead);
      socket.off('message:recalled', onRecalled);
      socket.off('user:updated', onUserUpdated);

      socket.off('friend:req:new', onFriendReqNew);
      socket.off('friend:list', onFriendList);
      socket.off('friend:req:accepted', onFriendAccepted);

      socket.off('group:list', onGroupList);
      socket.off('group:req:new', onGroupReqNew);
      socket.off('group:updated', onGroupUpdated);
      socket.off('group:removed', onGroupRemoved);
      socket.off('room:public:updated', onPublicRoomUpdated);

      // 【新增】
      socket.off('redpacket:new', onRedPacketNew);
      socket.off('transfer:new', onTransferNew);

      socket.off('stickers:pack:updated', onStickerChanged);
      socket.off('stickers:pack:removed', onStickerChanged);
      socket.off('stickers:pack:subscribed', onStickerChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, user.id]);

  // ── 房间操作 ───────────────────────────────────────────
  const openRoom = (room) => {
    if (!room) return;
    setActiveKey(room.key);
    setTab('messages');
    setView('chat');
    setReplyTo(null);
    setTypingUsers(new Set());
    setRooms((prev) =>
      prev.map((r) => (r.key === room.key ? { ...r, unread: 0 } : r))
    );
    setUnread(0);
    if (socket) {
      socket.emit('room:open', { roomType: room.type, roomId: room.roomId });
    }
  };

  const openPrivateChat = (friend) => {
    const roomId = privateRoomId(user.id, friend.id);
    const key = roomId;
    let room = rooms.find((r) => r.key === key);
    if (!room) {
      room = {
        key,
        type: 'private',
        roomId,
        peerId: friend.id,
        name: friend.nickname,
        avatar: friend.avatar,
        unread: 0,
        lastMessage: null
      };
      setRooms((prev) => [...prev, room]);
    }
    setActiveKey(key);
    setTab('messages');
    setView('chat');
    setReplyTo(null);
    setTypingUsers(new Set());
    setUnread(0);
    if (socket) {
      socket.emit('room:open', { roomType: 'private', roomId });
    }
  };

  const openGroupChat = (group) => {
    const roomId = `g_${group.id}`;
    const key = roomId;
    let room = rooms.find((r) => r.key === key);
    if (!room) {
      room = {
        key,
        type: 'group',
        roomId,
        groupId: group.id,
        name: group.name,
        avatar: group.avatar,
        unread: 0,
        lastMessage: null
      };
      setRooms((prev) => [...prev, room]);
    }
    setActiveKey(key);
    setTab('messages');
    setView('chat');
    setReplyTo(null);
    setTypingUsers(new Set());
    setUnread(0);
    if (socket) {
      socket.emit('room:open', { roomType: 'group', roomId });
    }
  };

  // ── 消息发送 / 输入 ────────────────────────────────────
  const handleSend = useCallback(
    (payload) => {
      if (!activeRoom) return;
      emit('message:send', {
        roomType: activeRoom.type,
        roomId: activeRoom.roomId,
        text: payload.text,
        fileUrl: payload.fileUrl,
        fileName: payload.fileName,
        fileType: payload.fileType,
        fileSize: payload.fileSize,
        isSticker: !!payload.isSticker,
        stickerPackId: payload.stickerPackId || null,
        replyToId: replyTo?.id || null
      });
      setReplyTo(null);
    },
    [emit, activeRoom, replyTo]
  );

  const handleTyping = useCallback(
    (isTyping) => {
      if (!activeRoom) return;
      emit(isTyping ? 'typing:start' : 'typing:stop', {
        roomType: activeRoom.type,
        roomId: activeRoom.roomId
      });
    },
    [emit, activeRoom]
  );

  const handleRead = useCallback((id) => emit('message:read', id), [emit]);

  // 【新增】点击消息头像 → 弹出用户卡片
  const handleAvatarClick = useCallback((userId) => {
    if (userId == null) return;
    setUserCardId(userId);
  }, []);

  const handleDraftChange = useCallback((text) => {
    const k = activeKeyRef.current;
    setDraftsByRoom((prev) => {
      if (prev[k] === text) return prev;
      return { ...prev, [k]: text };
    });
  }, []);

  const handleAtBottom = useCallback((atBottom) => {
    atBottomRef.current = atBottom;
    if (atBottom) {
      setShowScrollBtn(false);
      if (!document.hidden) setUnread(0);
    }
  }, []);

  const scrollToBottom = () => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
    setShowScrollBtn(false);
    setUnread(0);
  };

  const visibleMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter((m) => (m.text || '').toLowerCase().includes(q));
  }, [messages, searchQuery]);

  // 导航栏切换界面
  // [FIX TDZ] 这个方法必须在 buildMenuItems 之前定义，因为后者的 deps
  //   数组里直接引用了它；useCallback 的依赖数组是立即求值的。
  const openView = useCallback((name, opts = {}) => {
    if (opts.tab) setTab(opts.tab);
    if (name === 'shop') {
      if (opts.shopTab) setShopTab(opts.shopTab);
      if (opts.category !== undefined) setShopCategory(opts.category);
    }
    if (name === 'admin' && opts.adminTab) setAdminTab(opts.adminTab);
    if (name === 'groupInfo' && opts.groupId) setGroupInfoId(opts.groupId);
    // [NEW] 打开插件：记录要运行的插件 id
    if (name === 'plugin' && opts.pluginId) setPluginHostId(opts.pluginId);
    // [FIX] plugins 页的默认 tab（SideNav 的「已安装 / 发现 / 我发布的」走这里）。
    //   之前漏了这一支，导致三个入口点进去都停在 PluginManager 内部的
    //   默认 'all' tab。viewNonce 递增会让 PluginManager 整块重挂载，
    //   因此 useState 的初始值能生效。
    if (name === 'plugins' && opts.scope) setPluginScope(opts.scope);
    setViewNonce((n) => n + 1);
    setView(name);
  }, []);

  /**
   * 表情消息的右键菜单分流：
   *   · 不是表情消息 → 保持原有「复制 / 引用 / 撤回」
   *   · 是表情消息：
   *     - 我拥有 / 订阅该表情包 → 「查看表情包」+（自己发的）「撤回」
   *     - 我没有 → 「购买表情包」
   *   刻意不提供「复制 / 引用 / 下载」—— 从菜单层面堵住"顺手另存"。
   */
  const buildMenuItems = useCallback(
    (ctx) => {
      const { message, isSelf } = ctx;

      // 【新增】支付消息：只给"复制金额"这种轻量操作
      if (message.refType === 'transfer' || message.refType === 'red_packet') {
        return [
          {
            label: '复制金额',
            onClick: () => {
              const amount = message.refType === 'transfer'
                ? message.amount
                : message.totalAmount;
              if (amount != null && navigator.clipboard) {
                navigator.clipboard.writeText(String(amount));
              }
            }
          }
        ];
      }

      if (message.isSticker && message.fileUrl) {
        const packId = message.stickerPackId || null;
        const owned = packId ? !!myStickerPacks[packId] : false;

        const openPackManager = () => {
          setView('stickers');
          setViewNonce((n) => n + 1);
        };

        // [FIX B1] 「购买表情包」直接打开该表情包对应的商品详情。
        //   以前是 openView('shop', { shopTab:'flea', category:'sticker_pack' })，
        //   跳到商城的「表情包」分类让用户自己找。
        //   现在通过 /api/stickers/lookup 反查该表情对应的 productId
        //   （只有 source='purchase' 的表情包才有；用户自建的表情包没有
        //   对应商品），能反查到就 setStickerBuyProductId(pid)，
        //   下面那个 ProductDetailModal 渲染分支会真正打开。
        const openBuy = async () => {
          try {
            const d = await lookupSticker(message.fileUrl);
            const pid = d?.info?.productId || null;
            if (!pid) {
              alert('这个表情包不是从商城购买的，没有对应的商品详情');
              return;
            }
            setStickerBuyProductId(pid);
          } catch (err) {
            alert(err.message || '无法打开商品详情');
          }
        };

        const items = [];
        if (!owned) {
          items.push({ label: '购买表情包', onClick: openBuy });
        } else {
          items.push({ label: '查看表情包', onClick: openPackManager });
        }

        if (isSelf) {
          items.push({ divider: true });
          items.push({
            label: '撤回',
            danger: true,
            onClick: () => {
              if (!socket) return;
              socket.emit('message:recall', message.id, (ack) => {
                if (ack?.error) alert(ack.error);
              });
            }
          });
        }
        return items;
      }

      const items = [
        {
          label: '复制',
          onClick: () => {
            const t = message.text || message.fileName || '';
            if (t && navigator.clipboard) navigator.clipboard.writeText(t);
          }
        },
        { label: '引用', onClick: () => setReplyTo(message) }
      ];
      if (isSelf) {
        items.push({ divider: true });
        items.push({
          label: '撤回',
          danger: true,
          onClick: () => {
            if (!socket) return;
            socket.emit('message:recall', message.id, (ack) => {
              if (ack?.error) alert(ack.error);
            });
          }
        });
      }
      return items;
    },
    // [FIX C1] 补上 openView（原来漏列，只因它是空依赖的稳定引用才没出问题）。
    //   [CHANGED] 认证改造后 lookupSticker 不再需要 token，依赖数组里删掉 token。
    [socket, myStickerPacks, openView]
  );

  // ── 好友 / 群 操作 ────────────────────────────────────
  const handleProfileSaved = (u) => {
    onUserUpdate(u);
    emit('user:refresh');
  };

  const acceptFriend = (requestId) => {
    socket.emit('friend:accept', { requestId });
    setReceivedFriendReqs((prev) => prev.filter((r) => r.id !== requestId));
  };
  const rejectFriend = (requestId) => {
    socket.emit('friend:reject', { requestId });
    setReceivedFriendReqs((prev) => prev.filter((r) => r.id !== requestId));
  };
  const approveGroup = (requestId) => {
    socket.emit('group:approve', { requestId });
    setPendingGroupReqs((prev) => prev.filter((r) => r.id !== requestId));
  };
  const rejectGroup = (requestId) => {
    socket.emit('group:reject', { requestId });
    setPendingGroupReqs((prev) => prev.filter((r) => r.id !== requestId));
  };

  const sortedRooms = useMemo(() => {
    const pub = roomList.find((r) => r.key === 'public');
    const others = roomList.filter((r) => r.key !== 'public');
    others.sort((a, b) => {
      const ta = a.lastMessage?.createdAt || 0;
      const tb = b.lastMessage?.createdAt || 0;
      return tb - ta;
    });
    return pub ? [pub, ...others] : others;
  }, [roomList]);

  const canOpenAdmin =
    can('view_audit') || can('review_price') || can('review_promotion');
  const canRequestPromotion = role !== 'developer' && role !== 'super_admin';
  const canManagePublicRoom = can('manage_public_room');

  const selectTab = useCallback((next) => {
    setTab(next);
    setView('chat');
  }, []);

  const backToChat = useCallback(() => setView('chat'), []);

  const closeView = (fn) => () => {
    backToChat();
    if (fn) fn();
  };

  // ── 插件：支付确认桥 ──────────────────────────────────
  //
  // 插件通过 hostAPI.call('payment.request', {...}) 发起，
  // bridge 会先查 pay-info（服务端会算单次/每日/余额校验），
  // 然后**调这个 onPayment 回调** —— 我们弹宿主侧确认框，
  // 用户点"确认支付"才 resolve(true)。
  //
  // [SEC] 这个对话框必须画在**宿主**里，不能是插件 iframe 里的 UI：
  //   插件可以把"确认"按钮画成"取消"，把金额 1000 显示成 1。
  const handlePluginPayment = useCallback((info) => {
    return new Promise((resolve) => {
      setPayDialog({ info, resolve });
    });
  }, []);

  const closePayDialog = (confirmed) => {
    setPayDialog((cur) => {
      if (cur?.resolve) {
        try { cur.resolve(!!confirmed); } catch { /* ignore */ }
      }
      return null;
    });
  };

  // 插件通过桥调 message.send 时，复用现有 emit 走同一条通道
  const handlePluginSendMessage = useCallback(
    (payload) => {
      if (!socket) throw new Error('未连接');
      emit('message:send', {
        roomType: payload.roomType,
        roomId: payload.roomId,
        text: payload.text,
        fileUrl: null,
        fileName: null,
        fileType: null,
        fileSize: null,
        isSticker: false,
        stickerPackId: null,
        replyToId: null
      });
    },
    [socket, emit]
  );

  // 插件 ui.toast 走一个轻量提示（用 alert 兜底，不引入新的 toast 组件）
  const handlePluginToast = useCallback((text) => {
    alert(String(text || ''));
  }, []);

  const adminTabs = useMemo(() => adminTabsFor(can), [can]);

  // ── 【新增】支付弹窗的打开条件 ─────────────────────────
  //   转账：仅私聊（activeRoom 有 peerId）
  //   红包：私聊 / 群聊（不含公共聊天，避免刷屏）
  const canTransfer = activeRoom?.type === 'private' && !!activeRoom.peerId;
  const canRedPacket = activeRoom?.type === 'private' || activeRoom?.type === 'group';

  const peerInfo = useMemo(() => {
    if (activeRoom?.type !== 'private') return null;
    const f = friends.find((x) => x.id === activeRoom.peerId);
    return f || {
      id: activeRoom.peerId,
      nickname: activeRoom.name,
      avatar: activeRoom.avatar || '',
      isFriend: false
    };
  }, [activeRoom, friends]);

  // 除 chat 外的界面都在这里；.view 里统一渲染整页内容
  const renderView = () => {
    switch (view) {
      case 'shop':
        // [FIX B2] 不再传死 prop `me`（ShopPage 内部不使用）。
        // [CHANGED] 认证改造后不再传 token。
        return (
          <ShopPage
            can={can}
            initialTab={shopTab}
            initialCategory={shopCategory}
          />
        );
      case 'appearance':
        return (
          <AppearanceModal
            roomKey={activeKey}
            roomLabel={activeRoom?.name}
            onClose={backToChat}
            onSaved={(next) => setPrefs(next)}
          />
        );
      case 'assets':
        return <AssetLibraryModal onClose={backToChat} onChanged={() => {}} />;
      case 'stickers':
        return (
          <StickerPackManager
            onClose={backToChat}
            onChanged={() => setStickerRevision((v) => v + 1)}
          />
        );
      case 'apikeys':
        return <ApiKeysModal onClose={backToChat} />;
      case 'admin':
        return (
          <AdminPanel
            me={{ ...user, role }}
            can={can}
            initialTab={adminTab}
            onClose={backToChat}
          />
        );
      case 'points':
        return <PointsHistoryModal onClose={backToChat} />;
      case 'profile':
        return (
          <AvatarEditor
            user={user}
            onSaved={handleProfileSaved}
            onClose={backToChat}
          />
        );
      case 'promote':
        return (
          <RoleRequestModal
            me={{ ...user, role }}
            onClose={closeView(refreshRole)}
          />
        );
      case 'addFriend':
        return <AddFriendModal socket={socket} onClose={backToChat} />;
      case 'createGroup':
        return <CreateGroupModal socket={socket} friends={friends} onClose={backToChat} />;
      case 'joinGroup':
        return <JoinGroupModal socket={socket} onClose={backToChat} />;
      case 'groupInfo':
        return (
          <GroupInfoModal
            socket={socket}
            groupId={groupInfoId}
            me={user}
            friends={friends}
            onClose={backToChat}
          />
        );
      case 'publicRoomIcon':
        return (
          <PublicRoomIconModal
            room={publicRoom}
            onClose={backToChat}
            onSaved={setPublicRoom}
          />
        );

      // ── 插件系统 ──
      case 'plugins':
        // [FIX] 把 SideNav 传来的默认 tab 透传给 PluginManager。
        //   viewNonce 的递增会让这层 <section> 整体重挂载，
        //   所以 initialScope 每次都会重新生效。
        //
        // [本次改动 · 插件系统 v3] 增加 socket 透传 —— PluginManager
        //   用它监听 plugin:updated 广播（作者上传新版本时，已安装用户
        //   会看到"更新"角标）。
        return (
          <PluginManager
            role={role}
            initialScope={pluginScope}
            socket={socket}
            onOpenPlugin={(id) => openView('plugin', { pluginId: id })}
            onError={(msg) => alert(msg)}
          />
        );
      case 'plugin':
        if (!pluginHostId) {
          return <div className="modal-empty">未指定插件</div>;
        }
        return (
          <PluginHost
            pluginId={pluginHostId}
            user={user}
            friends={friends}
            rooms={sortedRooms}
            onClose={backToChat}
            onToast={handlePluginToast}
            onPayment={handlePluginPayment}
            onSendMessage={handlePluginSendMessage}
          />
        );

      default:
        return null;
    }
  };

  return (
    <div className="app">
      <SideNav
        view={view}
        tab={tab}
        user={user}
        role={role}
        connected={connected}
        onlineUsers={onlineUsers}
        rooms={sortedRooms}
        friends={friends}
        groups={groups}
        receivedFriendReqs={receivedFriendReqs}
        pendingGroupReqs={pendingGroupReqs}
        canOpenAdmin={canOpenAdmin}
        canRequestPromotion={canRequestPromotion}
        canManagePublicRoom={canManagePublicRoom}
        adminTabs={adminTabs}
        onSelectTab={selectTab}
        onOpenView={openView}
        onOpenRoom={openRoom}
        onOpenPrivateChat={openPrivateChat}
        onOpenGroupChat={openGroupChat}
        onOpenPublicRoomIcon={() => openView('publicRoomIcon')}
        onLogout={onLogout}
      />

      <div className="app-body">
        {view === 'chat' ? (
          <>
            <ListPanel
              tab={tab}
              user={user}
              onlineUsers={onlineUsers}
              rooms={sortedRooms}
              activeKey={activeKey}
              onOpenRoom={openRoom}
              friends={friends}
              receivedFriendReqs={receivedFriendReqs}
              onAcceptFriend={acceptFriend}
              onRejectFriend={rejectFriend}
              onOpenPrivateChat={openPrivateChat}
              groups={groups}
              pendingGroupReqs={pendingGroupReqs}
              onApproveGroup={approveGroup}
              onRejectGroup={rejectGroup}
              onOpenGroupChat={openGroupChat}
              onOpenView={openView}
              onOpenUserCard={handleAvatarClick}
            />

            <main className="chat-area" style={appearanceStyle}>
              <ChatHeader
                room={activeRoom}
                searchOpen={searchOpen}
                onToggleSearch={() => {
                  setSearchOpen((v) => !v);
                  if (searchOpen) setSearchQuery('');
                }}
                onOpenGroupInfo={() => openView('groupInfo', { groupId: activeRoom?.groupId })}
                canManagePublicRoom={canManagePublicRoom}
                onOpenPublicRoomIcon={() => openView('publicRoomIcon')}
                onOpenUserCard={handleAvatarClick}
              />

              {searchOpen && (
                <div className="search-bar">
                  <input
                    autoFocus
                    className="search-input"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索消息内容..."
                  />
                  {searchQuery && (
                    <span className="search-count">{visibleMessages.length} 条</span>
                  )}
                </div>
              )}

              <div className="messages-wrap">
                <MessageList
                  messages={visibleMessages}
                  virtuosoRef={virtuosoRef}
                  searchQuery={searchQuery}
                  currentUserId={user.id}
                  // 【新增】把 socket 透传给 MessageBubble → 支付卡片
                  socket={socket}
                  onRead={handleRead}
                  onOpenMenu={setContextMenu}
                  onImageClick={setLightbox}
                  onAtBottom={handleAtBottom}
                  onAvatarClick={handleAvatarClick}
                />
              </div>

              {showScrollBtn && (
                <button className="scroll-to-bottom" onClick={scrollToBottom}>
                  回到最新
                </button>
              )}

              <TypingIndicator names={Array.from(typingUsers)} />

              {replyTo && <ReplyBar replyTo={replyTo} onCancel={() => setReplyTo(null)} />}

              <ChatInput
                key={activeKey}
                draft={draftsByRoom[activeKey] || ''}
                onDraftChange={handleDraftChange}
                onSend={handleSend}
                onTyping={handleTyping}
                disabled={!connected}
                onlineUsers={onlineUsers}
                selfId={user.id}
                stickerRevision={stickerRevision}
                onOpenStickerManager={() => openView('stickers')}
                // 【新增】"+" 菜单：转账 / 红包
                roomType={activeRoom?.type}
                onOpenTransfer={canTransfer ? () => setTransferOpen(true) : undefined}
                onOpenRedPacket={canRedPacket ? () => setRedPacketOpen(true) : undefined}
              />
            </main>
          </>
        ) : (
          <section className="view" key={`${view}-${viewNonce}`}>
            {renderView()}
          </section>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems(contextMenu)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 【新增】用户卡片：点击头像弹出（头像 / 昵称 / 签名 / 加好友 / 私信） */}
      {userCardId != null && (
        <UserCardModal
          userId={userCardId}
          me={user}
          socket={socket}
          friends={friends}
          onlineUsers={onlineUsers}
          onClose={() => setUserCardId(null)}
          onPrivateChat={(u) => {
            setUserCardId(null);
            openPrivateChat(u);
          }}
        />
      )}

      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          protected={!!lightbox.protected}
          onClose={() => setLightbox(null)}
        />
      )}

      {/* [FIX B1] 右键表情消息 →「购买表情包」→ 打开对应商品详情。
          之前这个分支永远不触发（stickerBuyProductId 从未被赋过非空值），
          现在 openBuy 反查到 productId 后会 setStickerBuyProductId(pid)。 */}
      {stickerBuyProductId && (
        // [FIX] 不再传死 prop `me` —— ProductDetailModal 的签名里没有它，
        //   传了只会是白费。ChatRoom 侧同步删掉。
        <ProductDetailModal
          productId={stickerBuyProductId}
          can={can}
          onClose={() => setStickerBuyProductId(null)}
          onBought={() => {
            setStickerRevision((v) => v + 1);
            setStickerBuyProductId(null);
          }}
          onDelisted={() => setStickerBuyProductId(null)}
        />
      )}

      {/* [NEW] 插件支付确认框（宿主侧 —— 关键安全一环） */}
      {payDialog && (
        <PluginPayDialog
          info={payDialog.info}
          onConfirm={() => closePayDialog(true)}
          onCancel={() => closePayDialog(false)}
        />
      )}

      {/* 【新增】转账弹窗（仅私聊可用） */}
      {transferOpen && peerInfo && (
        <TransferDialog
          peer={peerInfo}
          onClose={() => setTransferOpen(false)}
          onCreated={() => { /* 转账成功后 socket 会广播，无需额外动作 */ }}
        />
      )}

      {/* 【新增】红包弹窗（私聊 / 群聊） */}
      {redPacketOpen && activeRoom && (
        <RedPacketDialog
          roomType={activeRoom.type}
          roomId={activeRoom.roomId}
          onClose={() => setRedPacketOpen(false)}
          onCreated={() => { /* 同上 */ }}
        />
      )}
    </div>
  );
}