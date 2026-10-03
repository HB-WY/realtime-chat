// src/routes/index.js
//
// 路由挂载总表。
//
// 【本次改动】挂载支付系统（转账 / 红包）路由。
//
const express = require('express');
const router = express.Router();

router.use('/auth', require('./auth'));
router.use('/',     require('./user'));
router.use('/',     require('./shop'));
router.use('/',     require('./shop_admin'));
router.use('/',     require('./roles'));
router.use('/',     require('./download'));

// 通用模块
router.use('/',     require('./preferences'));
router.use('/',     require('./assets'));
router.use('/',     require('./stickers'));
router.use('/',     require('./apikeys'));
router.use('/',     require('./rooms'));
router.use('/',     require('./fileTypes'));
router.use('/',     require('./media'));

// 【新增】支付系统（转账 / 红包）
router.use('/',     require('./transfers'));
router.use('/',     require('./redpackets'));

// 插件系统（P1–P5）
//   · P1: 上传 / 安装 / 入口 / 资源
//   · P2: 权限（manifest 声明 + 安装时授权）
//   · P3: KV 存储（plugin_kv 表）
//   · P4: 分享码 / 订阅
//   · P5: 支付（pluginPayments）
router.use('/',     require('./plugins'));
router.use('/',     require('./pluginPayments'));

// REST 镜像层（消息 / 好友 / 群聊 / 在线状态），让脚本用密钥即可等价调用
router.use('/',     require('./v1'));

module.exports = router;
