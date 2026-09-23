// 家庭帳號的 mock（僅 VITE_USE_MOCK=true）：讓個人頁的「我的家庭」能在本機預覽。
// 預設是「還沒有家庭、名下有一位跟別的帳號重複的孩子、有一筆等我同意的申請」；在瀏覽器 console 執行
// localStorage.setItem('mock.family', 'member')（或 'owner'）後重新整理，可以看「已在家庭裡」的樣子。
const REL = {
  father: '爸爸', mother: '媽媽', grandfather: '爺爺', grandmother: '奶奶',
  maternal_grandfather: '外公', maternal_grandmother: '外婆', guardian: '其他照顧者',
};

let joinRequest = null;
let invites = [];
let incoming = [
  { id: 'in-mock-1', relationship: 'grandmother', relationship_label: '奶奶', note: '平常負責接送',
    created_at: new Date(Date.now() - 3600000).toISOString(), applicant_name: '李奶奶', student_name: '（示範）小明' },
];
let members = null;

function mode() {
  try { return localStorage.getItem('mock.family') || ''; } catch { return ''; }
}
function setMode(v) {
  try { if (v) localStorage.setItem('mock.family', v); else localStorage.removeItem('mock.family'); } catch { /* 預覽用，忽略 */ }
}

export const familyMock = {
  // 給 mock 的 GET /parents/me 附上 family 區塊
  blockFor(parent) {
    if (mode() === 'off') return null;
    if (mode() === 'member' || mode() === 'owner') {
      const owner = mode() === 'owner';
      members = members || [
        { parent_id: owner ? parent?.id || 'me' : 'mock-mom', name: owner ? parent?.name || '我' : '王媽媽', role: 'owner',
          relationship: 'mother', relationship_label: '媽媽', is_self: owner },
        { parent_id: owner ? 'mock-dad' : parent?.id || 'me', name: owner ? '王爸爸' : parent?.name || '我', role: 'member',
          relationship: 'father', relationship_label: '爸爸', is_self: !owner },
      ];
      return {
        family: {
          id: 'fam-mock', name: null, status: 'active', role: owner ? 'owner' : 'member',
          relationship: owner ? 'mother' : 'father', relationship_label: owner ? '媽媽' : '爸爸',
          members,
          students: [
            { id: 'mock-kid-1', name: '王小明', birth_date: '2018-05-12', gender: '生理男',
              owner_parent_id: owner ? 'mock-dad' : 'mock-mom', owner_name: owner ? '王爸爸' : '王媽媽', owner_relationship_label: owner ? '爸爸' : '媽媽' },
          ],
        },
        join_request: null,
        duplicates: [],
        rebind_required: false,
        can_invite: owner, // 只有擁有者可以邀請
        invites: owner ? invites : [],
        incoming_requests: owner ? incoming : [],
      };
    }
    const firstKid = (parent?.students || [])[0];
    return {
      family: null,
      join_request: joinRequest,
      duplicates: firstKid && !joinRequest ? [{ student_id: firstKid.id, name: firstKid.name }] : [],
      rebind_required: false,
      can_invite: !joinRequest,
      invites,
      incoming_requests: incoming,
    };
  },
  createRequest(data) {
    if (String(data.parent_phone) === '0900000000') {
      const err = new Error('mismatch');
      err.response = { status: 422, data: { error: '資料不符，請確認孩子的名字與對方家長的手機號碼，或洽櫃台協助。', code: 'FAMILY_REQUEST_NOT_MATCHED' } };
      throw err;
    }
    joinRequest = {
      id: 'req-mock', status: 'pending', relationship: data.relationship, relationship_label: REL[data.relationship] || '家人',
      created_at: new Date().toISOString(), reject_reason: null, target_student_name: data.student_name || '（示範）孩子',
    };
    return { ok: true, request: joinRequest };
  },
  cancelRequest() { joinRequest = null; return { ok: true }; },
  approveRequest(id) { incoming = incoming.filter((r) => r.id !== id); setMode('owner'); members = null; return { ok: true }; },
  rejectRequest(id) { incoming = incoming.filter((r) => r.id !== id); return { ok: true }; },
  revokeMember(parentId) { members = (members || []).filter((m) => m.parent_id !== parentId); return { ok: true }; },
  createInvite() {
    const inv = { id: `inv-${Date.now()}`, url: `/liff/family/join/mock${Date.now().toString(16)}`,
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7 * 86400000).toISOString() };
    invites = [inv, ...invites];
    return { ok: true, invite: inv };
  },
  revokeInvite(id) { invites = invites.filter((i) => i.id !== id); return { ok: true }; },
  invitePreview(token) {
    if (String(token).startsWith('bad')) {
      const err = new Error('invalid');
      err.response = { status: 410, data: { error: '這個邀請連結已經過期，請向邀請您的家人或櫃台索取新的連結', code: 'INVITE_EXPIRED' } };
      throw err;
    }
    return { owner_name: '王媽媽', member_count: 1, relationship: null, expires_at: new Date(Date.now() + 6 * 86400000).toISOString(),
      own_invite: String(token).startsWith('own'), already_member: mode() === 'member', in_other_family: false };
  },
  acceptInvite() {
    setMode('member');
    return { ok: true, family_id: 'fam-mock' };
  },
  leave() {
    setMode('');
    return { ok: true };
  },
};
