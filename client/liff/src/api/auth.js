import { callApi } from './client';

export const authApi = {
  // ── 家長 LINE-first 登入 ──────────────────────────────────────
  // POST /api/auth/parent-line-login { id_token }
  //   → { status:'logged_in', parent, token } | { status:'need_phone_binding', line_uid }
  parentLineLogin: (idToken) =>
    callApi('/auth/parent-line-login', { method: 'post', data: { id_token: idToken } },
      // mock：無 idToken 就回 need_phone_binding 讓 dev 走得下去
      () => ({ status: 'need_phone_binding', line_uid: 'U_dev_mock' })
    ),

  // POST /api/auth/parent-bind-phone { id_token, phone }
  //   → { status:'bound_and_logged_in', parent, token }
  //   | { status:'need_registration', line_uid, phone }
  //   | 409 LINE_ALREADY_BOUND_TO_OTHER_PHONE / PHONE_ALREADY_BOUND_TO_OTHER_LINE
  //   | { status:'need_claim_verification', line_uid, phone }（此門號已有家庭資料 → 需驗證認領）
  //   claim?: { student_name, phone, parent_name? } — 認領既有家庭時附上學員姓名 + 登記手機號碼；
  //           parent_name 為家長本人真實姓名，後端只在既有姓名是「電話佔位」時才據以清洗回寫 Ragic Z01。
  parentBindPhone: ({ idToken, phone, claim }) =>
    callApi('/auth/parent-bind-phone',
      { method: 'post', data: { id_token: idToken, phone, claim: claim || undefined } },
      // mock：直接讓使用者進到註冊流程
      () => ({ status: 'need_registration', line_uid: 'U_dev_mock', phone })
    ),

  // POST /api/auth/parent-register-line { id_token, parent, students }
  //   → { status:'registered_and_logged_in', parent, token }
  //   | 409 LINE_ALREADY_REGISTERED / PHONE_EXISTS_USE_BINDING / LINE_ALREADY_BOUND_TO_OTHER_PHONE
  parentRegisterLine: ({ idToken, parent, students, refToken, demo }) =>
    callApi('/auth/parent-register-line',
      {
        method: 'post',
        data: {
          id_token: idToken,
          demo: demo || undefined,
          parent, students,
          ref_token: refToken || undefined,
        },
      },
      () => ({
        status: 'registered_and_logged_in',
        parent: {
          id: 'mock-parent-' + Date.now(),
          ...parent,
          students,
          token: 'mock.jwt.token',
        },
        token: 'mock.jwt.token',
        ref_bound: !!refToken,
        ref_error: null,
      })
    ),

  // ── Demo 登入（手機功能測試，繞過 LINE）──────────────────────
  // POST /api/auth/demo-login { username, password }
  //   → { role:'coach'|'parent', ...payload, token }
  demoLogin: ({ username, password }) =>
    callApi('/auth/demo-login', { method: 'post', data: { username, password } },
      () => ({ role: 'parent', id: 'mock-parent-demo', name: '示範家長', phone: '0912345678', students: [], token: 'mock.jwt.token' })
    ),
};
