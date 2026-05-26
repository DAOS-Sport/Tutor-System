import { callApi } from './client';

export const authApi = {
  // 真實階段會帶 LINE access token 比對 Z01；Phase 1 mock 直接成功
  bindLineUid: ({ lineUid, parentId }) =>
    callApi('/auth/bind-line', { method: 'post', data: { lineUid, parentId } }, () => ({
      ok: true,
      bound_at: new Date().toISOString(),
    })),

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
  parentBindPhone: ({ idToken, phone }) =>
    callApi('/auth/parent-bind-phone', { method: 'post', data: { id_token: idToken, phone } },
      // mock：直接讓使用者進到註冊流程
      () => ({ status: 'need_registration', line_uid: 'U_dev_mock', phone })
    ),

  // POST /api/auth/parent-register-line { id_token, parent, students }
  //   → { status:'registered_and_logged_in', parent, token }
  //   | 409 LINE_ALREADY_REGISTERED / PHONE_EXISTS_USE_BINDING / LINE_ALREADY_BOUND_TO_OTHER_PHONE
  parentRegisterLine: ({ idToken, parent, students, refToken }) =>
    callApi('/auth/parent-register-line',
      {
        method: 'post',
        data: {
          id_token: idToken,
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
};
