// 家庭帳號的 mock（僅 VITE_USE_MOCK=true）：讓個人頁的「我的家庭」能在本機預覽。
// 預設是「還沒有家庭、名下有一位跟別的帳號重複的孩子」；在瀏覽器 console 執行
// localStorage.setItem('mock.family', 'member') 後重新整理，可以看「已在家庭裡」的樣子。
const REL = {
  father: '爸爸', mother: '媽媽', grandfather: '爺爺', grandmother: '奶奶',
  maternal_grandfather: '外公', maternal_grandmother: '外婆', guardian: '其他照顧者',
};

let joinRequest = null;

function mode() {
  try { return localStorage.getItem('mock.family') || ''; } catch { return ''; }
}

export const familyMock = {
  // 給 mock 的 GET /parents/me 附上 family 區塊
  blockFor(parent) {
    if (mode() === 'off') return null;
    if (mode() === 'member') {
      return {
        family: {
          id: 'fam-mock', name: null, status: 'active', role: 'member', relationship: 'father', relationship_label: '爸爸',
          members: [
            { parent_id: 'mock-mom', name: '王媽媽', role: 'owner', relationship: 'mother', relationship_label: '媽媽', is_self: false },
            { parent_id: parent?.id || 'me', name: parent?.name || '我', role: 'member', relationship: 'father', relationship_label: '爸爸', is_self: true },
          ],
          students: [
            { id: 'mock-kid-1', name: '王小明', birth_date: '2018-05-12', gender: '生理男', owner_parent_id: 'mock-mom', owner_name: '王媽媽', owner_relationship_label: '媽媽' },
          ],
        },
        join_request: null,
        duplicates: [],
        rebind_required: false,
      };
    }
    const firstKid = (parent?.students || [])[0];
    return {
      family: null,
      join_request: joinRequest,
      duplicates: firstKid && !joinRequest ? [{ student_id: firstKid.id, name: firstKid.name }] : [],
      rebind_required: false,
    };
  },
  createRequest(data) {
    if (String(data.birth_date) === '2000-01-01') {
      const err = new Error('mismatch');
      err.response = { status: 422, data: { error: '資料不符，請確認孩子的身分證字號與生日，或洽櫃台協助。', code: 'FAMILY_REQUEST_NOT_MATCHED' } };
      throw err;
    }
    joinRequest = {
      id: 'req-mock', status: 'pending', relationship: data.relationship, relationship_label: REL[data.relationship] || '家人',
      created_at: new Date().toISOString(), reject_reason: null, target_student_name: '（示範）孩子',
    };
    return { ok: true, request: joinRequest };
  },
  cancelRequest() { joinRequest = null; return { ok: true }; },
  leave() {
    try { localStorage.removeItem('mock.family'); } catch { /* 預覽用，忽略 */ }
    return { ok: true };
  },
};
