import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { groupOrdersApi } from '../api/groupOrders';
import GroupMemberFields from '../components/group/GroupMemberFields';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel } from '../utils/format';

/**
 * 以邀請碼加入團購頁（/group/join/:token）。
 * 先預覽團購（他家庭資料後端已遮罩），確認後填自己學生 + 匯款證明加入。
 */
export default function GroupJoinPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [preview, setPreview] = useState(undefined); // undefined=loading, null=error
  const [fields, setFields] = useState({ studentNames: [''], proofUrl: '' });
  const [uploading, setUploading] = useState(false);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let alive = true;
    groupOrdersApi.preview(token)
      .then((d) => alive && setPreview(d || null))
      .catch(() => alive && setPreview(null));
    return () => { alive = false; };
  }, [token]);

  if (preview === undefined) return <LoadingSpinner fullPage label="載入團購資訊…" />;
  if (preview === null) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="mb-3 text-sm text-brand-error">邀請碼無效或團購不存在</div>
        <button type="button" onClick={() => navigate('/', { replace: true })}
          className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white">回首頁</button>
      </div>
    );
  }

  if (preview.already_member) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="mb-3 text-3xl">✅</div>
        <h3 className="text-sm font-bold text-gray-700">您已加入此團購</h3>
        <button type="button" onClick={() => navigate(`/group/${preview.id}`, { replace: true })}
          className="mt-4 rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white">查看團購狀態</button>
      </div>
    );
  }

  const cleanNames = fields.studentNames.map((s) => s.trim()).filter(Boolean);
  const canJoin = preview.joinable && cleanNames.length > 0 && !!fields.proofUrl && !uploading && !joining;

  async function handleJoin() {
    if (!canJoin) return;
    setJoining(true);
    try {
      const order = await groupOrdersApi.join(token, {
        student_names: cleanNames,
        payment_proof_url: fields.proofUrl,
      });
      toast.success('已加入團購！');
      navigate(`/group/${order.id}`, { replace: true });
    } catch (e) {
      toast.error(e?.response?.data?.error || '加入失敗');
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="px-4 py-4 pb-10">
      <div className="mb-4 rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-3">
        <h2 className="text-sm font-bold text-brand-primary">加入 {courseTypeLabel(preview.course_type)} 團購</h2>
        <p className="mt-1 text-xs text-gray-600">
          目前 <span className="font-bold">{preview.total_students}</span> 人，開團需 {preview.min_students}–{preview.max_students} 人
        </p>
        <p className="mt-0.5 text-xs text-gray-400">團主：{preview.members?.find((m) => m.is_leader)?.parent_name || '—'}</p>
      </div>

      {!preview.joinable ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white px-6 py-10 text-center">
          <div className="mb-2 text-2xl">🔒</div>
          <p className="text-sm text-gray-600">此團購已不在揪團中，無法加入</p>
        </div>
      ) : (
        <>
          <GroupMemberFields
            value={fields}
            onChange={setFields}
            uploading={uploading}
            setUploading={setUploading}
          />
          <button
            type="button"
            disabled={!canJoin}
            onClick={handleJoin}
            className="mt-4 w-full rounded-lg bg-brand-primary py-3.5 text-base font-bold text-white active:bg-brand-teal disabled:bg-gray-300"
          >
            {joining ? '加入中…' : '確認加入團購'}
          </button>
        </>
      )}
    </div>
  );
}
