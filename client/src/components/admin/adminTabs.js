// client/src/components/admin/adminTabs.js
//
// 当前账号实际拥有的管理页签（按能力过滤）。
// 导航栏的下拉菜单与管理面板共用这一份，避免菜单里出现点不动的入口。
//
// 注意：这是 **default export** —— 调用方用
//   import adminTabsFor from './adminTabs'
//   import adminTabsFor from '../admin/adminTabs'
// 如果你改成了 named export，要同步改这两个调用方。
//
import AdminUsersTab from './AdminUsersTab';
import AdminAuditTab from './AdminAuditTab';
import AdminReviewTab from './AdminReviewTab';
import AdminRoleRequestsTab from './AdminRoleRequestsTab';
import AdminApiKeysTab from './AdminApiKeysTab';
import AdminPluginsTab from './AdminPluginsTab';
import AdminPluginPaymentsTab from './AdminPluginPaymentsTab';

export default function adminTabsFor(can) {
  const tabs = [];

  if (can('review_price')) {
    tabs.push({
      key: 'review',
      label: '定价审核',
      icon: 'receipt',
      component: AdminReviewTab
    });
  }

  if (can('view_audit')) {
    tabs.push({
      key: 'users',
      label: '用户管理',
      icon: 'user',
      component: AdminUsersTab
    });
  }

  if (can('review_promotion')) {
    tabs.push({
      key: 'roles',
      label: '升职审批',
      icon: 'promote',
      component: AdminRoleRequestsTab
    });
  }

  if (can('manage_apikeys')) {
    tabs.push({
      key: 'apikeys',
      label: 'API 密钥',
      icon: 'key',
      component: AdminApiKeysTab
    });
  }

  // 插件管理（两个页签共用 review_plugin 能力位）
  if (can('review_plugin')) {
    tabs.push({
      key: 'plugins',
      label: '插件管理',
      icon: 'package',
      component: AdminPluginsTab
    });
    tabs.push({
      key: 'plugin-payments',
      label: '插件支付',
      icon: 'gem',
      component: AdminPluginPaymentsTab
    });
  }

  if (can('view_audit')) {
    tabs.push({
      key: 'audit',
      label: '审计日志',
      icon: 'shield',
      component: AdminAuditTab
    });
  }

  return tabs;
}