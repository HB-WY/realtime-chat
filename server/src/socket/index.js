// src/socket/index.js
const { Server } = require('socket.io');
const { socketAuth } = require('../auth');
const helpers = require('./helpers');
const registry = require('./registry');
const registerMessageHandlers  = require('./handlers/message');
const registerFriendHandlers   = require('./handlers/friend');
const registerGroupHandlers    = require('./handlers/group');
const registerRoomHandlers     = require('./handlers/room');
const registerPresenceHandlers = require('./handlers/presence');
// 【新增】支付系统（转账 / 红包）
const registerPaymentHandlers  = require('./handlers/payment');

module.exports = function setupSocket(server) {
  const io = new Server(server);
  io.use(socketAuth);

  // 把 io 注册进 registry：REST（API 密钥通道）也通过它推送
  registry.init(io);

  // [SEC] registry 把 onlineUsers 作为模块私有 Map 持有，只导出 getter
  //       `getOnlineUsers()`；这里必须用 getter —— 早期写成解构 `onlineUsers`
  //       会拿到 undefined，presence.js 的 user:refresh 一调用就 TypeError，
  //       而 handler 里没有 try/catch → uncaughtException → 整个进程退出。
  const { broadcastOnline, sendTo, emitToRoom } = registry;

  // 注入到每个 handler
  const ctx = {
    io,
    onlineUsers: registry.getOnlineUsers(),
    broadcastOnline, sendTo, emitToRoom,
    ...helpers
  };

  // ============================================================
  // [SEC] 兜底：socket 事件处理器抛出的异常默认会变成 uncaughtException，
  //       直接把整个进程带走（一次畸形 payload 就能 DoS）。
  //       这里给每个 handler 统一包一层 try/catch + Promise.catch：
  //       · 同步 throw 走 catch
  //       · async handler 的 rejected Promise 走 .catch
  //       两者都只记日志 + 回 ack，进程继续服务。
  //       放在注册 handler 之前，后续新增处理器自动受保护。
  // ============================================================
  const guardSocket = (socket) => {
    const rawOn = socket.on.bind(socket);
    socket.on = (event, handler) => {
      if (typeof handler !== 'function') return rawOn(event, handler);
      return rawOn(event, (...args) => {
        // 最后一个参数是 ack（如果客户端传了的话）；提前取出来，
        // 无论同步还是异步失败都走同一条回复路径。
        const ack = args[args.length - 1];
        const replyError = (err) => {
          console.error(`[socket] ${event} 处理失败:`, err);
          if (typeof ack === 'function') {
            try { ack({ error: err?.message || '服务端处理失败' }); } catch { /* ignore */ }
          }
        };
        try {
          const ret = handler(...args);
          // [FIX] 原先只 try/catch 同步部分 —— 一旦 handler 是 async，
          //   rejected Promise 会变成 unhandledRejection（本项目没有
          //   process.on('unhandledRejection') 兜底），进程随即退出。
          //   现补 .catch() 把异步失败也导向同一条 ack + 日志路径。
          if (ret && typeof ret.then === 'function') {
            ret.catch(replyError);
          }
          return ret;
        } catch (err) {
          replyError(err);
          return undefined;
        }
      });
    };
  };

  io.on('connection', (socket) => {
    const user = socket.user;

    registry.addSocket(user, socket.id);

    socket.emit('state:init', helpers.buildInitState(user));
    broadcastOnline();

    guardSocket(socket);

    registerMessageHandlers(socket, ctx);
    registerFriendHandlers(socket, ctx);
    registerGroupHandlers(socket, ctx);
    registerRoomHandlers(socket, ctx);
    registerPresenceHandlers(socket, ctx);
    // 【新增】支付系统
    registerPaymentHandlers(socket, ctx);

    socket.on('disconnect', () => {
      registry.removeSocket(user.id, socket.id);
      broadcastOnline();
    });
  });

  return {
    io,
    getOnlineCount: () => registry.getOnlineCount()
  };
};