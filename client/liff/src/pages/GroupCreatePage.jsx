import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { groupOrdersApi } from '../api/groupOrders';
import GroupMemberFields from '../components/group/GroupMemberFields';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel } from '../utils/format';

/**
 * 發起團購頁。由報名頁帶 venue / coach / courseType 進來。
 * 團主填自己的學生 + 匯款證明 → 建立團購 → 導到狀態頁分享邀請碼。
 */
export default function GroupCreatePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const venueId = params.get('venue') || '';
  const coachId = params.get('coach') || '';
  const courseType = Number(params.get('courseType') || 2);

  const [fields, setFields] = useState({ studentNames: [''], proofUrl: '' });
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState('');

  const cleanNames = fields.studentNames.map((s) => s.trim()).filter(Boolean);
  const canSubmit = !!venueId && cleanNames.length > 0 && !!fields.proofUrl && !uploading && !submitting;

  async function handleCreate() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const order = await groupOrdersApi.create({
        course_type: courseType,
        venue_id: venueId,
        coach_id: coachId || undefined,
        student_names: cleanNames,
        payment_proof_url: fields.proofUrl,
        note: note.trim() || undefined,
      });
      toast.success('團購已建立，快邀請其他家長加入！');
      navigate(`/group/${order.id}`, { replace: true });
    } catch (e) {
      toast.error(e?.response?.data?.error || '發起團購失敗');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-4 py-4 pb-10">
      <div className="mb-4 rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-3">
        <h2 className="text-sm font-bold text-brand-primary">發起 {courseTypeLabel(courseType)} 團購</h2>
        <p className="mt-1 text-xs text-gray-500">
          您將成為團主，先填好自己的學生與匯款證明。建立後會取得邀請碼，分享給其他家長一起湊滿開團人數。
        </p>
      </div>

      <GroupMemberFields
        value={fields}
        onChange={setFields}
        uploading={uploading}
        setUploading={setUploading}
      />

      <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3">
        <label className="mb-1 block text-xs font-medium text-gray-600">備註（選填）</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 500))}
          rows={2}
          placeholder="例如：希望週六下午班"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none"
        />
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={handleCreate}
        className="mt-4 w-full rounded-lg bg-brand-primary py-3.5 text-base font-bold text-white active:bg-brand-teal disabled:bg-gray-300"
      >
        {submitting ? '建立中…' : '建立團購'}
      </button>
    </div>
  );
}
