import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { groupOrdersApi } from '../api/groupOrders';
import GroupMemberFields, { memberFieldsReady, memberFieldsPayload } from '../components/group/GroupMemberFields';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { setAfterAuth } from '../utils/afterAuth';
import { courseTypeLabel } from '../utils/format';

/**
 * 以邀請碼加入團購頁（/group/join/:token）— 公開頁（免登入可先看狀態）。
 * 流程：唯讀看團購（含已加入家庭：家長 + 名下學生，他家資料一律遮罩）→ 已登入直接選自己學生加入；
 *      未登入則導去 LINE 登入/註冊，完成後自動回到本頁繼續加入。
 * 註：不需輸入家長手機——收到連結＋LINE 登入即可直接加入，身分一律以 LINE 登入的家長為準。
 *     已是團員者自動導去團購狀態頁（不在本頁顯示「查看團購狀態」連結）。
 */
function JoinIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.7-5.6 6-5.6" strokeLinecap="round" />
      <path d="M17.5 11v6M14.5 14h6" strokeLinecap="round" />
    </svg>
  );
}

export default function GroupJoinPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { isAuthed, role } = useAuth();
  const authedParent = isAuthed && role === 'parent';

  const [preview, setPreview] = useState(undefined); // undefined=loading, null=error
  const [fields, setFields] = useState({ studentIds: [], newStudents: [], proofUrl: '' });
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');

  useEffect(() => {
    let alive = true;
    groupOrdersApi.preview(token)
      .then((d) => alive && setPreview(d || null))
      .catch(() => alive && setPreview(null));
    return () => { alive = false; };
  }, [token]);

  // 已是團員 → 直接導去團購狀態頁（取代舊版「查看團購狀態」連結）。
  useEffect(() => {
    if (preview && preview.already_member) {
      navigate(`/group/${preview.id}`, { replace: true });
    }
  }, [preview, navigate]);

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
  if (preview.already_member) return <LoadingSpinner fullPage label="前往團購狀態…" />;

  // 人數已滿 → 顯示「該團已滿」並隱藏所有資訊。上限一律取後端 max_students（勿寫死數字）。
  const maxStudents = Number(preview.max_students) || 0;
  const isFull = maxStudents > 0 && Number(preview.total_students || 0) >= maxStudents;
  if (isFull) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="mb-3 text-3xl">🈵</div>
        <h3 className="text-sm font-bold text-gray-700">該團已滿</h3>
        <p className="mt-1 text-xs text-gray-500">此團購人數已達上限，無法再加入。</p>
        <button type="button" onClick={() => navigate('/', { replace: true })}
          className="mt-4 rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white">回首頁</button>
      </div>
    );
  }

  function goLoginAndJoin() {
    setAfterAuth(`/group/join/${token}`);
    navigate('/login', { state: { from: { pathname: `/group/join/${token}` } } });
  }

  const canJoin = authedParent && memberFieldsReady(fields) && !joining;

  async function handleJoin() {
    if (!canJoin) return;
    setJoinError('');
    setJoining(true);
    try {
      const order = await groupOrdersApi.join(token, { ...memberFieldsPayload(fields) });
      toast.success('已加入團購！');
      navigate(`/group/${order.id}`, { replace: true });
    } catch (e) {
      const message = e?.response?.data?.error || '加入失敗';
      setJoinError(message);
      toast.error(message);
    } finally {
      setJoining(false);
    }
  }

  const reachedMin = preview.total_students >= preview.min_students;
  const members = preview.members || [];

  return (
    <div className="px-4 py-4 pb-10">
      {/* ① 唯讀團購狀態 */}
      <div className="mb-4 rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-3">
        <h2 className="text-sm font-bold text-brand-primary">{courseTypeLabel(preview.course_type)} 團購</h2>
        <p className="mt-1 text-xs text-gray-600">
          目前 <span className="font-bold">{preview.total_students}</span> 人，需 {preview.min_students}–{preview.max_students} 人成團
        </p>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div className={`h-full rounded-full ${reachedMin ? 'bg-brand-green' : 'bg-brand-gold'}`}
            style={{ width: `${Math.min(100, Math.round((preview.total_students / preview.max_students) * 100))}%` }} />
        </div>
      </div>

      {/* ② 已加入的家庭（他家資料遮罩：家長遮中間字、學生只露姓氏＋「同學」） */}
      {members.length > 0 && (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
          <h3 className="mb-2 text-xs font-bold text-gray-600">已加入家庭（{members.length}）</h3>
          <div className="space-y-2">
            {members.map((m) => (
              <div key={m.id} className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 transition-colors hover:border-brand-teal/40">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">家長：{m.parent_name || '—'}</span>
                  {m.is_leader && (
                    <span className="rounded bg-brand-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-brand-primary">團主</span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-gray-500">
                  名下學生（{m.student_count ?? (m.student_names || []).length} 位）：
                  {(m.student_names || []).join('、') || '—'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ③ 加入：已登入直接選自己學生；未登入先 LINE 登入（不需輸入手機） */}
      {!preview.joinable ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white px-6 py-10 text-center">
          <div className="mb-2 text-2xl">🔒</div>
          <p className="text-sm text-gray-600">此團購已不在揪團中，無法加入</p>
        </div>
      ) : authedParent ? (
        <>
          <GroupMemberFields
            value={fields}
            onChange={(next) => { setJoinError(''); setFields(next); }}
            maxStudents={Math.max(0, (preview.max_students || 0) - (preview.total_students || 0))}
            error={joinError}
          />
          <button
            type="button"
            disabled={!canJoin}
            onClick={handleJoin}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-primary py-3.5 text-base font-bold text-white active:bg-brand-teal disabled:bg-gray-300"
          >
            <JoinIcon />
            {joining ? '加入中…' : '加入此團'}
          </button>
        </>
      ) : (
        <div className="rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-4 text-center">
          <button
            type="button"
            onClick={goLoginAndJoin}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal"
          >
            <JoinIcon />
            加入此團
          </button>
          <p className="mt-2 text-xs text-gray-400">點擊後用 LINE 登入即可加入，登入後會自動回到這裡。</p>
        </div>
      )}
    </div>
  );
}
