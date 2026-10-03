// client/src/components/admin/AdminReviewTab.jsx
//
// 【本次改动】submitReview 加空值判错：
//   价格初值是空字符串，Number('') === 0 —— 管理员直接点"确认"会把商品
//   以 0 积分免费上架（无二次确认）。现在显式要求用户输入：
//   想要免费就明确填 0，空着会报错。
//
// [CHANGED] 认证改造：不再接收 token prop。
// [FIX] 删掉无用的 eslint-disable 注释 —— 改造后 load() 不再依赖外部变量，
//   deps=[] 就是正确的，没有 exhaustive-deps 告警需要抑制。
//
import { useEffect, useState } from 'react';
import Avatar from '../common/Avatar';
import Icon from '../common/Icon';
import { adminPendingReview, adminReviewPrice } from '../../api';
import { formatShortDateTime } from '../../utils/timeUtils';

export default function AdminReviewTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // { id, price, note }

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const d = await adminPendingReview();
      setItems(d.products || []);
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const submitReview = async () => {
    if (!editing) return;
    // [FIX] 空值判错
    if (editing.price === '' || editing.price === null || editing.price === undefined) {
      alert('请填写价格（0 = 免费上架）');
      return;
    }
    const price = Number(editing.price);
    // 价格下限为 0：免费商品同样走审核流程，审核时可定价为 0
    if (!Number.isInteger(price) || price < 0 || price > 100000) {
      alert('价格需为 0-100000 的整数（0 = 免费）');
      return;
    }
    try {
      await adminReviewPrice(editing.id, price, editing.note || '');
      alert('已定价并上架到标准市场');
      setEditing(null);
      load();
    } catch (err) {
      alert(err.message || '审核失败');
    }
  };

  return (
    <div className="admin-tab-content">
      {error && <div className="auth-error">{error}</div>}
      {loading && <div className="modal-empty">加载中...</div>}
      {!loading && items.length === 0 && (
        <div className="modal-empty">暂无待审核商品</div>
      )}

      <div className="admin-list">
        {items.map((p) => (
          <div key={p.id} className="review-row">
            <Avatar name={p.sellerName} avatar={p.sellerAvatar} size={32} />
            <div className="review-info">
              <div className="review-title">{p.title}</div>
              <div className="review-desc">{p.description || '（无描述）'}</div>
              <div className="review-meta">
                卖家 {p.sellerName} · 提交 {formatShortDateTime(p.createdAt)}
              </div>
              {/* 待审核接口不下发文件 URL（商品文件必须走鉴权下载），
                  这里只展示文件数量，避免渲染一个永远为空的下载链接。 */}
              {p.fileCount > 0 && (
                <div className="review-file">
                  <Icon name="package" size={13} /> {p.fileCount} 个文件
                </div>
              )}
            </div>
            <div className="review-actions">
              {editing?.id === p.id ? (
                <>
                  <input
                    className="auth-input"
                    type="number"
                    min={0}
                    max={100000}
                    value={editing.price}
                    onChange={(e) =>
                      setEditing({ ...editing, price: e.target.value })
                    }
                    placeholder="积分（0 = 免费）"
                    style={{ width: 120 }}
                    autoFocus
                  />
                  <input
                    className="auth-input"
                    value={editing.note}
                    onChange={(e) =>
                      setEditing({ ...editing, note: e.target.value })
                    }
                    placeholder="备注（可选）"
                    style={{ width: 160, marginTop: 4 }}
                  />
                  <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                    <button className="mini-btn ok" onClick={submitReview}>
                      确认
                    </button>
                    <button
                      className="mini-btn"
                      onClick={() => setEditing(null)}
                    >
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className="mini-btn ok"
                  onClick={() =>
                    setEditing({ id: p.id, price: '', note: '' })
                  }
                >
                  定价
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}