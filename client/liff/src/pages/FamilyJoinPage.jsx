import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { familyApi, RELATIONSHIP_OPTIONS } from '../api/family';
import { setAfterAuth } from '../utils/afterAuth';
import { formatTWDateTime } from '../utils/format';

/**
 * 家庭邀請連結（/family/join/:token）—— 櫃台在後台產生、傳給家人（擁有者 2026-09-23）。
 * 在 LINE 裡打開會自動登入；沒登入就先記住這一頁再去登入（還沒註冊的人註冊完也會回來）。
 * 按「加入家庭」後綁定的是這位家長當下的 LINE userId；連結只能用一次。
 */
const inputCls = 'w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand-primary';

export default function FamilyJoinPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { isAuthed, role, parent } = useAuth();
  const authedParent = isAuthed && role === 'parent' && !!parent?.id;
  const [preview, setPreview] = useState(undefined); // undefined＝載入中；{ error }＝不能用；其他＝可加入
  const [relationship, setRelationship] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authedParent) {
      setAfterAuth(`/family/join/${token}`);
      navigate('/login', { replace: true, state: { from: { pathname: `/family/join/${token}` } } });
      return undefined;
    }
    let alive = true;
    familyApi.invitePreview(token)
      .then((d) => {
        if (!alive) return;
        setPreview(d || { error: '邀請連結無效，請向櫃台索取新的連結' });
        if (d?.relationship) setRelationship(d.relationship);
      })
      .catch((err) => { if (alive) setPreview({ error: err?.response?.data?.error || '邀請連結無效，請向櫃台索取新的連結' }); });
    return () => { alive = false; };
  }, [token, authedParent, navigate]);

  async function accept() {
    if (!relationship || busy) return;
    setBusy(true);
    try {
      await familyApi.acceptInvite(token, relationship);
      toast.success('已加入家庭！之後可以一起查看孩子的課程、繳費、簽到');
      navigate('/profile', { replace: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || '加入家庭失敗，請稍後再試', 4200);
    } finally {
      setBusy(false);
    }
  }

  if (!authedParent || preview === undefined) return <LoadingSpinner fullPage label="載入邀請…" />;

  const Notice = ({ icon, title, body, action }) => (
    <div className="px-4 py-10 text-center">
      <div className="mb-3 text-3xl">{icon}</div>
      <h3 className="text-sm font-bold text-gray-800">{title}</h3>
      {body && <p className="mt-1 text-xs leading-5 text-gray-500">{body}</p>}
      <button type="button" onClick={() => navigate(action?.to || '/', { replace: true })}
        className="mt-4 rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white">{action?.label || '回首頁'}</button>
    </div>
  );

  if (preview.error) return <Notice icon="🔗" title="無法使用這個邀請" body={preview.error} />;
  if (preview.already_member) {
    return <Notice icon="👨‍👩‍👧" title="您已經在這個家庭裡了" action={{ to: '/profile', label: '查看我的家庭' }} />;
  }
  if (preview.in_other_family) {
    return (
      <Notice icon="🏠" title="您已經在另一個家庭裡"
        body="一個帳號同一時間只能在一個家庭。要加入這個家庭，請先到個人頁退出目前的家庭（擁有者請洽櫃台）。"
        action={{ to: '/profile', label: '前往個人頁' }} />
    );
  }
  if (preview.family_frozen) {
    return <Notice icon="⏸️" title="這個家庭目前暫停共用" body="請聯絡櫃台協助。" />;
  }

  return (
    <div className="px-4 py-6">
      <div className="rounded-2xl border border-gray-200 bg-white p-5 text-center shadow-sm">
        <div className="mb-2 text-3xl">👨‍👩‍👧</div>
        <h2 className="text-base font-bold text-brand-primary">
          {preview.owner_name ? `「${preview.owner_name}」邀請您加入家庭` : '您收到一個家庭邀請'}
        </h2>
        <p className="mt-1 text-xs text-gray-500">目前 {preview.member_count} 人・連結有效到 {formatTWDateTime(preview.expires_at)}</p>
        <p className="mt-3 text-xs leading-5 text-gray-600">
          加入後，全家可以一起查看孩子的課程、幫忙繳費、簽到與預約。孩子的基本資料仍由所屬的家長維護。
        </p>
        <label className="mt-4 block text-left">
          <span className="mb-1 block text-xs font-medium text-gray-600">您是孩子的</span>
          <select className={inputCls} value={relationship} onChange={(e) => setRelationship(e.target.value)}>
            <option value="">請選擇</option>
            {RELATIONSHIP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <button type="button" disabled={!relationship || busy} onClick={accept}
          className="mt-4 w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal disabled:bg-gray-300">
          {busy ? '加入中…' : '加入家庭'}
        </button>
        <p className="mt-2 text-[11px] text-gray-400">這個連結只能用一次。不是給您的邀請，請不要加入並告知櫃台。</p>
      </div>
    </div>
  );
}
