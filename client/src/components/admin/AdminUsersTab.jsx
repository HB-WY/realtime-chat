import { useEffect, useState } from 'react';
import Avatar from '../common/Avatar';
import { adminListUsers, adminSetUserStatus } from '../../api';

/**
 * 管理面板 · 用户列表。
 *
 * [CHANGED] 认证改造：不再接收 token prop。
 */
export default function AdminUsersTab({ me, can }) {
  const [keyword, setKeyword] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const d = await adminListUsers(keyword.trim());
      setUsers(d.users || []);
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setStatus = async (u, status) => {
    let reason = '';
    if (status !== 'active') {
      const input = prompt(`请输入${status === 'banned' ? '查封' : '禁用'}原因：`);
      // 用户点了「取消」→ 放弃本次操作，绝不能当成空原因继续封禁 / 禁用
      if (input === null) return;
      reason = input.trim();
    }
    try {
      await adminSetUserStatus(u.id, status, reason);
      alert('操作成功');
      load();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  const canBan = can('ban_user');

  return (
    <div className="admin-tab-content">
      <div className="search-row">
        <input
          className="auth-input"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
          placeholder="搜索用户名或昵称"
        />
        <button
          className="auth-submit"
          style={{ width: 100, marginTop: 0 }}
          onClick={load}
        >
          搜索
        </button>
      </div>

      {error && <div className="auth-error">{error}</div>}
      {loading && <div className="modal-empty">加载中...</div>}

      <div className="admin-list">
        {users.map((u) => {
          const isSelf = u.id === me.id;
          const isDeveloper = u.role === 'developer';
          const isSuperAdmin = u.role === 'super_admin';
          const canOperate =
            !isSelf &&
            !isDeveloper &&
            !(isSuperAdmin && me.role !== 'developer');

          return (
            <div key={u.id} className="admin-user-row">
              <Avatar name={u.nickname} avatar={u.avatar} size={32} />
              <div className="admin-user-info">
                <div className="admin-user-name">
                  {u.nickname}
                  <span className={`role-tag role-${u.role}`}>
                    {roleLabel(u.role)}
                  </span>
                  <span className={`status-tag status-${u.status}`}>
                    {statusLabel(u.status)}
                  </span>
                </div>
                <div className="admin-user-sub">@{u.username}</div>
              </div>
              <div className="admin-user-actions">
                {canOperate && u.status === 'active' && (
                  <>
                    <button
                      className="mini-btn"
                      onClick={() => setStatus(u, 'disabled')}
                    >
                      禁用
                    </button>
                    {canBan && (
                      <button
                        className="mini-btn danger"
                        onClick={() => setStatus(u, 'banned')}
                      >
                        查封
                      </button>
                    )}
                  </>
                )}
                {canOperate && u.status !== 'active' && (
                  <button
                    className="mini-btn ok"
                    onClick={() => setStatus(u, 'active')}
                  >
                    恢复
                  </button>
                )}
                {!canOperate && (
                  <span className="admin-user-locked">不可操作</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function roleLabel(r) {
  return (
    {
      developer: '开发者',
      super_admin: '超级管理员',
      admin: '管理员',
      user: '用户'
    }[r] || r
  );
}

function statusLabel(s) {
  return { active: '正常', disabled: '已禁用', banned: '已查封' }[s] || s;
}