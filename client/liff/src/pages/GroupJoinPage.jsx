import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { groupOrdersApi } from '../api/groupOrders';
import GroupMemberFields, { memberFieldsReady, memberFieldsPayload } from '../components/group/GroupMemberFields';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { setAfterAuth } from '../utils/afterAuth';
import { courseTypeLabel, isValidTWPhone } from '../utils/format';

/**
 * 以邀請碼加入團購頁（/group/join/:token）— 公開頁（免登入可先看狀態）。
 * 流程：唯讀看團購狀態 → 輸入家長電話查名下學生+狀態 → 確認無誤 →
 *      已登入則填學生加入（綁本人學員，後端 best-effort 回寫 Ragic）；
 *      未登入則導去 LINE 登入/註冊，完成後自動回到本頁繼續加入。
 */
export default function GroupJoinPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { isAuthed, role, parent } = useAuth();
  const authedParent = isAuthed && role === 'parent';

  const [preview, setPreview] = useState(undefined); // undefined=loading, null=error
  const [phone, setPhone] = useState(parent?.phone || '');
  const [lookup, setLookup] = useState(undefined); // undefined=未查, null=查無, obj=結果
  const [lookupError, setLookupError] = useState('');
  const [looking, setLooking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [fields, setFields] = useState({ studentIds: [], newStudents: [], proofUrl: '' });
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

  async function handleLookup() {
    if (!isValidTWPhone(phone)) {
      setLookupError('請輸入正確的手機（09xxxxxxxx）');
      setLookup(undefined);
      setConfirmed(false);
      toast.error('請輸入正確的手機（09xxxxxxxx）');
      return;
    }
    setLookupError('');
    setLookup(undefined);
    setConfirmed(false);
    setLooking(true);
    try {
      const r = await groupOrdersApi.lookupPhone(token, phone.trim());
      setLookup(r || null);
    } catch (e) {
      const msg = e?.response?.data?.error || '查詢失敗，請稍後再試';
      setLookupError(msg);
      toast.error(msg);
    } finally {
      setLooking(false);
    }
  }

  function goLoginAndJoin() {
    setAfterAuth(`/group/join/${token}`);
    navigate('/login', { state: { from: { pathname: `/group/join/${token}` } } });
  }

  const phoneOk = isValidTWPhone(phone);
  const canLookup = phoneOk && !looking;
  const canJoin = authedParent && memberFieldsReady(fields) && !uploading && !joining;
  const phoneMatchesLogin = !authedParent || !parent?.phone || parent.phone === phone.trim();

  async function handleJoin() {
    if (!canJoin) return;
    setJoining(true);
    try {
      const order = await groupOrdersApi.join(token, {
        ...memberFieldsPayload(fields),
      });
      toast.success('已加入團購！');
      navigate(`/group/${order.id}`, { replace: true });
    } catch (e) {
      toast.error(e?.response?.data?.error || '加入失敗');
    } finally {
      setJoining(false);
    }
  }

  const reachedMin = preview.total_students >= preview.min_students;

  return (
    <div className="px-4 py-4 pb-10">
      {/* ① 唯讀團購狀態 */}
      <div className="mb-4 rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-3">
        <h2 className="text-sm font-bold text-brand-primary">{courseTypeLabel(preview.course_type)} 團購</h2>
        <p className="mt-1 text-xs text-gray-600">
          目前 <span className="font-bold">{preview.total_students}</span> 人，開團需 {preview.min_students}–{preview.max_students} 人
        </p>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div className={`h-full rounded-full ${reachedMin ? 'bg-brand-green' : 'bg-brand-gold'}`}
            style={{ width: `${Math.min(100, Math.round((preview.total_students / preview.max_students) * 100))}%` }} />
        </div>
        <p className="mt-1.5 text-xs text-gray-400">團主：{preview.members?.find((m) => m.is_leader)?.parent_name || '—'}</p>
      </div>

      {!preview.joinable ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white px-6 py-10 text-center">
          <div className="mb-2 text-2xl">🔒</div>
          <p className="text-sm text-gray-600">此團購已不在揪團中，無法加入</p>
        </div>
      ) : (
        <>
          {/* ② 輸入家長電話查名下學生 + 團報狀態 */}
          <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
            <label className="mb-1 block text-xs font-medium text-gray-600">輸入家長手機，確認名下學生與團報狀態</label>
            <div className="flex gap-2">
              <input type="tel" inputMode="numeric" placeholder="09xxxxxxxx"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none" />
              <button type="button" onClick={handleLookup} disabled={!canLookup}
                className="shrink-0 rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
                {looking ? '查詢中…' : '查詢'}
              </button>
            </div>
            {phone && !phoneOk && (
              <p className="mt-1 text-xs text-brand-error">手機需為 09 開頭共 10 碼。</p>
            )}
            {lookupError && (
              <div className="mt-3 rounded-lg border border-brand-error/20 bg-brand-error/5 px-3 py-2 text-xs leading-5 text-brand-error">
                {lookupError}
                <button type="button" onClick={handleLookup} disabled={!canLookup}
                  className="mt-2 block font-bold text-brand-error underline disabled:opacity-50">
                  重新查詢
                </button>
              </div>
            )}

            {lookup === null && (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                查無此手機資料。確認加入時將引導您完成家長註冊。
              </div>
            )}
            {lookup && lookup.found && (
              <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                <div>家長：{lookup.parent_name}</div>
                <div className="mt-0.5">名下學生（{lookup.student_count} 位）：{(lookup.students || []).join('、') || '—'}</div>
                <div className="mt-0.5">
                  本團狀態：
                  {lookup.already_member
                    ? <span className="font-bold text-brand-green">已加入此團</span>
                    : (lookup.joinable ? <span className="font-bold text-brand-teal">可加入</span> : <span className="text-gray-400">目前無法加入</span>)}
                </div>
                {lookup.already_member && (
                  <button type="button" onClick={() => navigate(`/group/${preview.id}`)}
                    className="mt-2 font-bold text-brand-primary">→ 查看團購狀態</button>
                )}
                {!lookup.already_member && lookup.joinable && !confirmed && (
                  <button type="button" onClick={() => setConfirmed(true)}
                    className="mt-2 w-full rounded-lg bg-brand-primary py-2 text-sm font-bold text-white">
                    {authedParent ? '確認無誤，選擇學生加入' : '確認無誤，登入後加入'}
                  </button>
                )}
                {!lookup.already_member && !lookup.joinable && (
                  <div className="mt-2 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-500">
                    此團目前狀態無法加入，請返回團購狀態頁或聯繫團主確認。
                  </div>
                )}
              </div>
            )}
            {lookup === null && !confirmed && (
              <button type="button" onClick={() => setConfirmed(true)}
                className="mt-2 w-full rounded-lg bg-brand-primary py-2 text-sm font-bold text-white">
                我要註冊並加入
              </button>
            )}
          </div>

          {/* ③ 確認後：已登入→填學生加入；未登入→導去登入/註冊 */}
          {confirmed && (
            authedParent && !phoneMatchesLogin ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-center">
                <p className="text-sm leading-6 text-amber-800">
                  您目前登入的手機是 <span className="font-mono font-bold">{parent.phone}</span>，
                  但剛剛查詢的是 <span className="font-mono font-bold">{phone.trim()}</span>。
                  請改查自己的手機，或登出後用正確 LINE 帳號登入。
                </p>
                <button type="button" onClick={goLoginAndJoin}
                  className="mt-3 w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal">
                  重新登入
                </button>
              </div>
            ) : authedParent ? (
              <>
                <GroupMemberFields
                  value={fields}
                  onChange={setFields}
                  uploading={uploading}
                  setUploading={setUploading}
                  maxStudents={Math.max(0, (preview.max_students || 0) - (preview.total_students || 0))}
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
            ) : (
              <div className="rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-4 text-center">
                <p className="mb-3 text-sm text-gray-600">請先以 LINE 登入（或完成註冊），登入後會自動回到這裡繼續加入。</p>
                <button type="button" onClick={goLoginAndJoin}
                  className="w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal">
                  使用 LINE 登入並加入
                </button>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
