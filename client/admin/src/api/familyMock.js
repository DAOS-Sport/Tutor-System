// 家庭帳號的 mock（僅 VITE_USE_MOCK=true 時使用）：讓 Z01 頁的家庭區塊與申請審核能在本機預覽。
// 家長 id 對應 api/mock.js 的 CUSTOMER_PARENTS（p-uuid-001 Mandy、p-uuid-002 戴凱莉）；資料都是示範用。

const now = () => new Date().toISOString();
const REL = {
  father: '爸爸', mother: '媽媽', grandfather: '爺爺', grandmother: '奶奶',
  maternal_grandfather: '外公', maternal_grandmother: '外婆', guardian: '其他照顧者',
};

const PEOPLE = {
  'p-uuid-001': { name: 'Mandy', phone: '0919488314', line_uid: 'U11223344556677889900abcdef' },
  'p-uuid-002': { name: '戴凱莉', phone: '0935141499', line_uid: 'U99887766554433221100fedcba' },
  'p-uuid-003': { name: '蕭宇成', phone: '0919136455', line_uid: null },
};

const state = {
  families: {
    'fam-mock-1': {
      id: 'fam-mock-1', name: null, status: 'active', owner_parent_id: 'p-uuid-001',
      created_at: '2026-09-23T02:00:00Z', created_by: 'admin:示範櫃台',
      members: [
        { parent_id: 'p-uuid-001', role: 'owner', relationship: 'mother', line_bound: true, linked_at: '2026-09-23T02:00:00Z', linked_by: 'admin:示範櫃台' },
      ],
      pending_members: [
        { id: 'pend-1', phone_canonical: '0911000333', relationship: 'grandmother', created_at: '2026-09-23T02:05:00Z', expires_at: '2026-10-23T02:05:00Z' },
      ],
      logs: [
        { id: 2, action: 'pending_member_added', actor: 'admin:示範櫃台', target_parent_id: null, detail: { phone_tail: '0333', relationship: 'grandmother' }, created_at: '2026-09-23T02:05:00Z' },
        { id: 1, action: 'family_created', actor: 'admin:示範櫃台', target_parent_id: 'p-uuid-001', detail: {}, created_at: '2026-09-23T02:00:00Z' },
      ],
    },
  },
  requests: [
    {
      id: 'req-mock-1', status: 'pending', relationship: 'guardian', relationship_label: '其他照顧者',
      note: '孩子的阿姨，平常接送', created_at: '2026-09-23T03:10:00Z',
      applicant_id: 'p-uuid-002', applicant_name: '戴凱莉', applicant_phone: '0935141499',
      target_id: 's-uuid-201', target_name: '張景祥', target_birth: '2019-04-04', target_in_ragic: true, target_periods: 2,
      owner_id: 'p-uuid-001', owner_name: 'Mandy', owner_phone: '0919488314', owner_venue: 'B',
      dup_id: 's-uuid-mock-dup', dup_name: '張景祥', dup_birth: '2019-04-04', dup_in_ragic: false, dup_periods: 0,
      duplicate_plan: { action: 'deactivate', studentId: 's-uuid-mock-dup', keepId: 's-uuid-201' },
    },
  ],
  suggestions: [
    {
      a: { student_id: 's-uuid-202', name: '林小寶', parent_id: 'p-uuid-002', parent_name: '戴凱莉', parent_phone: '0935141499', in_ragic: true, periods: 1, birth_date: '2018-05-12' },
      b: { student_id: 's-uuid-mock-203', name: '林小寶', parent_id: 'p-uuid-003', parent_name: '蕭宇成', parent_phone: '0919136455', in_ragic: false, periods: 0, birth_date: '2018-05-12' },
      suggested_owner_parent_id: 'p-uuid-002',
      duplicate_plan: { action: 'deactivate', studentId: 's-uuid-mock-203', keepId: 's-uuid-202' },
    },
  ],
};

function familyIdOf(parentId) {
  return Object.values(state.families).find((f) => f.members.some((m) => m.parent_id === parentId))?.id || null;
}
function log(fam, action, targetParentId, detail = {}) {
  fam.logs.unshift({ id: Date.now(), action, actor: 'admin:示範櫃台', target_parent_id: targetParentId, detail, created_at: now() });
}
function view(fam) {
  return {
    ...fam,
    members: fam.members.map((m) => ({
      ...m, name: PEOPLE[m.parent_id]?.name || m.parent_id, phone: PEOPLE[m.parent_id]?.phone || '',
      relationship_label: REL[m.relationship] || '家人', active_students: 1,
    })),
    pending_members: fam.pending_members.map((p) => ({ ...p, relationship_label: REL[p.relationship] || '家人' })),
    logs: fam.logs.map((l) => ({ ...l, target_name: PEOPLE[l.target_parent_id]?.name || null })),
  };
}
function fail(code, message) {
  const err = new Error(message);
  err.response = { status: 409, data: { error: message, code } };
  throw err;
}

export const familyMock = {
  summaryFor(parentId) {
    const id = familyIdOf(parentId);
    if (!id) return null;
    const fam = state.families[id];
    const me = fam.members.find((m) => m.parent_id === parentId);
    return {
      id, role: me.role, relationship: me.relationship, status: fam.status,
      owner_name: PEOPLE[fam.owner_parent_id]?.name || null, size: fam.members.length, line_bound: me.line_bound,
    };
  },
  byParent(parentId) {
    const id = familyIdOf(parentId);
    return { family: id ? view(state.families[id]) : null };
  },
  create(ownerParentId, ownerRelationship) {
    if (!PEOPLE[ownerParentId]?.line_uid) fail('LINE_NOT_BOUND', `${PEOPLE[ownerParentId]?.name || '這位家長'}還沒綁定 LINE，請先完成 LINE 綁定再加入家庭`);
    const id = `fam-mock-${Date.now()}`;
    state.families[id] = {
      id, name: null, status: 'active', owner_parent_id: ownerParentId, created_at: now(), created_by: 'admin:示範櫃台',
      members: [{ parent_id: ownerParentId, role: 'owner', relationship: ownerRelationship || null, line_bound: true, linked_at: now(), linked_by: 'admin:示範櫃台' }],
      pending_members: [], logs: [],
    };
    log(state.families[id], 'family_created', ownerParentId);
    return { ok: true, result: { id } };
  },
  addMember(familyId, { phone, parentId, relationship }) {
    const fam = state.families[familyId];
    const pid = parentId || Object.keys(PEOPLE).find((k) => PEOPLE[k].phone === phone);
    if (!pid) fail('PARENT_NOT_FOUND', '這支手機還沒有註冊，可以改用「預先登記」');
    if (!PEOPLE[pid].line_uid) fail('LINE_NOT_BOUND', `${PEOPLE[pid].name}還沒綁定 LINE，請先完成 LINE 綁定再加入家庭`);
    const existing = fam.members.find((m) => m.parent_id === pid);
    if (existing && existing.line_bound) fail('ALREADY_MEMBER', '這位家長已經是這個家庭的成員');
    if (existing) { existing.line_bound = true; log(fam, 'member_rebound', pid); return { ok: true, result: { rebound: true } }; }
    if (familyIdOf(pid)) fail('ALREADY_IN_FAMILY', '這位家長已經在另一個家庭裡，請先移出');
    fam.members.push({ parent_id: pid, role: 'member', relationship, line_bound: true, linked_at: now(), linked_by: 'admin:示範櫃台' });
    log(fam, 'member_added', pid, { relationship });
    return { ok: true };
  },
  setRelationship(familyId, parentId, relationship) {
    const fam = state.families[familyId];
    fam.members.find((m) => m.parent_id === parentId).relationship = relationship;
    log(fam, 'relationship_changed', parentId, { relationship });
    return { ok: true };
  },
  revoke(familyId, parentId) {
    const fam = state.families[familyId];
    const m = fam.members.find((x) => x.parent_id === parentId);
    if (m.role === 'owner') fail('OWNER_CANNOT_LEAVE', '擁有者不能直接移除，請先轉移擁有者');
    fam.members = fam.members.filter((x) => x.parent_id !== parentId);
    log(fam, 'member_revoked', parentId);
    return { ok: true };
  },
  transferOwner(familyId, parentId) {
    const fam = state.families[familyId];
    fam.members.forEach((m) => { m.role = m.parent_id === parentId ? 'owner' : 'member'; });
    fam.owner_parent_id = parentId;
    log(fam, 'owner_transferred', parentId);
    return { ok: true };
  },
  freeze(familyId, frozen) {
    const fam = state.families[familyId];
    fam.status = frozen ? 'frozen' : 'active';
    log(fam, frozen ? 'family_frozen' : 'family_unfrozen', null);
    return { ok: true };
  },
  addPending(familyId, phone, relationship) {
    const fam = state.families[familyId];
    if (Object.values(PEOPLE).some((p) => p.phone === phone)) fail('PARENT_EXISTS', '這支手機已經註冊過，請直接用「加入成員」');
    fam.pending_members.unshift({ id: `pend-${Date.now()}`, phone_canonical: phone, relationship, created_at: now(), expires_at: new Date(Date.now() + 30 * 86400000).toISOString() });
    log(fam, 'pending_member_added', null, { phone_tail: phone.slice(-4), relationship });
    return { ok: true };
  },
  removePending(familyId, pendingId) {
    const fam = state.families[familyId];
    fam.pending_members = fam.pending_members.filter((p) => p.id !== pendingId);
    log(fam, 'pending_member_removed', null);
    return { ok: true };
  },
  lookup(phone, name) {
    const pid = Object.keys(PEOPLE).find((k) => PEOPLE[k].phone === phone);
    if (!pid) return { found: false };
    const p = PEOPLE[pid];
    const norm = (s) => String(s || '').replace(/s/g, '');
    if (norm(name).length < 2 || !norm(p.name).includes(norm(name))) return { found: true, name_matches: false, name_hint: `${p.name.slice(0, 1)}○${p.name.slice(-1)}` };
    const fid = familyIdOf(pid);
    return {
      found: true, name_matches: true, parent_id: pid, name: p.name, line_uid: p.line_uid, line_bound: !!p.line_uid,
      in_family: fid ? { family_id: fid, owner_name: PEOPLE[state.families[fid].owner_parent_id]?.name || null } : null,
    };
  },
  addMemberForParent(parentId, { phone, name }) {
    const hit = familyMock.lookup(phone, name);
    if (!hit.found) fail('PARENT_NOT_FOUND', '找不到這支手機的家長帳號（還沒註冊的話，可以用「預先登記」）');
    if (!hit.name_matches) fail('NAME_MISMATCH', '手機號碼跟姓名對不上，請再確認');
    let fid = familyIdOf(parentId);
    if (!fid) fid = familyMock.create(parentId, null).result.id;
    return familyMock.addMember(fid, { parentId: hit.parent_id, relationship: null });
  },
  suggestions() { return { items: state.suggestions }; },
  applySuggestion(body) {
    state.suggestions = state.suggestions.filter((s) => s.a.student_id !== body.student_a_id);
    return { ok: true };
  },
  requests(status) { return { items: status === 'pending' ? state.requests : [] }; },
  approve(id) { state.requests = state.requests.filter((r) => r.id !== id); return { ok: true }; },
  reject(id) { state.requests = state.requests.filter((r) => r.id !== id); return { ok: true }; },
};
