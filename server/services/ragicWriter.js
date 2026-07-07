const axios = require('axios');
const { pool } = require('../models/db');
const line = require('./line');
const {
  FORMS,
  FIELD,
  H01,
  Z01_FIELDS,
  Z01_STUDENT_FIELDS,
  Z02_FIELDS,
} = require('../config/ragicSchema');

const RAGIC_TIMEOUT_MS = Number(process.env.RAGIC_TIMEOUT_MS) || 60000;
const RAGIC_API_VERSION = process.env.RAGIC_API_VERSION || '2025-01-01';

const UID_FIELD_IDS = new Set([
  String(FIELD.Z01.LINE_UID),
  String(H01.LINE_UID),
]);

function _splitFieldIds(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function _stripQuery(formPath) {
  return String(formPath || '').split('?')[0];
}

function _withApi(formPath) {
  return `${_stripQuery(formPath)}?api`;
}

function _recordPath(formPath, ragicRecordId) {
  return `${_stripQuery(formPath)}/${ragicRecordId}`;
}

function _apiParams(params = {}, options = {}) {
  const out = {
    version: RAGIC_API_VERSION,
    ...params,
    APIKey: process.env.RAGIC_API_KEY,
  };
  if (options.noCache) {
    out._ts = options.cacheBuster || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return out;
}

function _normalizeFormPath(formPath) {
  return _stripQuery(formPath).replace(/\/+$/, '');
}

function _sheetForm(sheet) {
  const code = String(sheet || '').toUpperCase();
  if (code === 'H01') return FORMS.H01;
  if (code === 'H05') return FORMS.H05;
  if (code === 'Z01') return FORMS.Z01;
  if (code === 'Z02') return FORMS.Z02;
  return null;
}

function sheetFromFormPath(formPath) {
  const target = _normalizeFormPath(formPath);
  for (const sheet of ['H01', 'H05', 'Z01', 'Z02']) {
    const base = _sheetForm(sheet);
    if (!base) continue;
    const norm = _normalizeFormPath(base);
    if (target === norm || target.startsWith(`${norm}/`)) return sheet;
  }
  return null;
}

function recordKeyFromFormPath(formPath) {
  const sheet = sheetFromFormPath(formPath);
  const base = sheet ? _normalizeFormPath(_sheetForm(sheet)) : '';
  const target = _normalizeFormPath(formPath);
  if (!base || !target.startsWith(`${base}/`)) return null;
  return target.slice(base.length + 1).split('/')[0] || null;
}

function _baseWritableFields() {
  return {
    H01: new Set([String(H01.LINE_UID)]),
    H05: new Set(),
    Z01: new Set([
      ...Object.values(FIELD.Z01 || {}),
      ...Object.values(Z01_FIELDS || {}),
      ...Object.values(Z01_STUDENT_FIELDS || {}),
    ].filter(Boolean).map(String)),
    Z02: new Set([
      ...Object.values(FIELD.Z02 || {}),
      ...Object.values(Z02_FIELDS || {}),
    ].filter(Boolean).map(String)),
  };
}

function _canaryFieldFor(sheet) {
  const prefix = `RAGIC_CANARY_${String(sheet || '').toUpperCase()}`;
  return (
    process.env[`${prefix}_NONCE_FIELD_ID`] ||
    process.env[`${prefix}_FIELD_ID`] ||
    process.env.RAGIC_CANARY_NONCE_FIELD_ID ||
    process.env.RAGIC_CANARY_FIELD_ID ||
    ''
  );
}

function _writableFields(sheet) {
  const code = String(sheet || '').toUpperCase();
  const all = _baseWritableFields();
  const fields = all[code] || new Set();
  const canaryField = _canaryFieldFor(code);
  if (canaryField) fields.add(String(canaryField));
  return fields;
}

function _blockedFields(sheet) {
  const code = String(sheet || '').toUpperCase();
  const ids = [];
  if (code === 'H01') {
    ids.push(..._splitFieldIds(process.env.RAGIC_FIELD_H01_400LINE_MESSAGE));
    ids.push(..._splitFieldIds(process.env.RAGIC_H01_BLOCKED_FIELD_IDS));
  }
  return new Set(ids.map(String));
}

function _payloadFieldId(key) {
  const s = String(key || '');
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/^\d+_\d+_(\d+)$/);
  return m ? m[1] : null;
}

async function _readOldValues(http, formPath, payload = {}, meta = {}) {
  if (!meta.recordKey || meta.oldValue !== undefined || meta.skipOldRead) return meta.oldValue;
  if (typeof http.get !== 'function') return meta.oldValue;
  try {
    const res = await http.get(_withApi(formPath), {
      params: _apiParams({}, { noCache: true }),
      headers: { 'Cache-Control': 'no-cache' },
    });
    const row = res.data || {};
    const entries = Object.entries(payload || {});
    if (entries.length === 1) {
      const fieldId = _payloadFieldId(entries[0][0]);
      return fieldId ? row[fieldId] : undefined;
    }
    const out = {};
    for (const [key] of entries) {
      const fieldId = _payloadFieldId(key);
      out[key] = fieldId ? row[fieldId] : undefined;
    }
    return JSON.stringify(out);
  } catch (err) {
    console.warn('[ragic-writer] old-value read failed:', err.message);
    return meta.oldValue;
  }
}

function normalizeLineUserId(value) {
  const uid = String(value || '').trim();
  if (!uid) return '';
  return /^U[0-9A-Fa-f]{32}$/.test(uid) ? uid : '';
}

function _validateField(sheet, fieldId, value) {
  const code = String(sheet || '').toUpperCase();
  const fid = String(fieldId || '');
  if (_blockedFields(code).has(fid)) {
    const err = new Error(`Ragic ${code} field ${fid} 已列入 BLOCKLIST，禁止寫入`);
    err.code = 'RAGIC_FIELD_BLOCKED';
    throw err;
  }
  const allowed = _writableFields(code);
  if (!allowed.has(fid)) {
    const err = new Error(`Ragic ${code} field ${fid} 不在寫入白名單`);
    err.code = 'RAGIC_FIELD_NOT_WRITABLE';
    throw err;
  }
  if (UID_FIELD_IDS.has(fid)) {
    const raw = String(value || '').trim();
    if (/chat\.line\.biz/i.test(raw) || raw.includes('://')) {
      const err = new Error(`Ragic ${code} UID 欄位 ${fid} 收到 URL/LINE chat link，已拒絕`);
      err.code = 'RAGIC_UID_URL_REJECTED';
      throw err;
    }
    if (!normalizeLineUserId(raw)) {
      const err = new Error(`Ragic ${code} UID 欄位 ${fid} 值格式不合法`);
      err.code = 'RAGIC_UID_INVALID';
      throw err;
    }
  }
}

function _validatePayload(sheet, payload = {}) {
  for (const [key, value] of Object.entries(payload || {})) {
    const fieldId = _payloadFieldId(key);
    if (!fieldId) {
      const err = new Error(`Ragic ${sheet} payload key "${key}" 不是 Field ID，禁止以欄位名稱寫入`);
      err.code = 'RAGIC_FIELD_NAME_WRITE_FORBIDDEN';
      throw err;
    }
    _validateField(sheet, fieldId, value);
  }
}

function _assertWriteOk(data) {
  const d = data || {};
  if (d.status && d.status !== 'SUCCESS') {
    throw new Error(`Ragic ${d.status} ${d.code || ''}: ${d.msg || ''}`.trim());
  }
  const hasRecordId =
    d.ragicId != null ||
    d._ragicId != null ||
    (d.data && typeof d.data === 'object' && (d.data._ragicId != null || d.data.ragicId != null));
  if (d.status !== 'SUCCESS' && !hasRecordId) {
    throw new Error('Ragic 寫入未確認成功（回應無 SUCCESS 狀態且無 record id）');
  }
}

function _normalizeRagicError(err) {
  const isTimeout =
    err?.code === 'ECONNABORTED' ||
    err?.code === 'ETIMEDOUT' ||
    /timeout/i.test(err?.message || '');
  if (isTimeout) {
    const e = new Error('Ragic 慢回應，請稍後再試');
    e.code = 'RAGIC_TIMEOUT';
    e.cause = err;
    return e;
  }
  const status = err?.response?.status;
  if (status) {
    const body = err.response.data;
    let detail = '';
    if (typeof body === 'string') detail = body.replace(/<[^>]*>/g, ' ').trim().slice(0, 200);
    else if (body && typeof body === 'object') detail = (body.msg || body.message || JSON.stringify(body)).slice(0, 200);
    const e = new Error(`Ragic 回應 HTTP ${status}${detail ? `：${detail}` : ''}`);
    e.code = 'RAGIC_HTTP_ERROR';
    e.status = status;
    e.cause = err;
    return e;
  }
  return err;
}

async function _defaultAudit(entry) {
  try {
    await pool.query(
      `INSERT INTO ragic_write_audit
         (sheet_code, record_key, field_id, old_value, new_value, actor, source, status, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.sheet,
        entry.recordKey || null,
        entry.fieldId || null,
        entry.oldValue == null ? null : String(entry.oldValue),
        entry.newValue == null ? null : String(entry.newValue),
        entry.actor || null,
        entry.source || null,
        entry.status,
        entry.reason || null,
      ]
    );
  } catch (err) {
    console.warn('[ragic-writer] audit insert failed:', err.message);
  }
}

async function _defaultAlert(text) {
  try {
    const mgrs = await pool.query(
      `SELECT line_uid, venue_id FROM admin_users
        WHERE role IN ('admin','manager') AND line_uid IS NOT NULL`
    );
    let fallbackVenue = null;
    if (mgrs.rows.some((m) => !m.venue_id)) {
      const v = await pool.query(`SELECT id FROM venues WHERE is_active = TRUE ORDER BY id LIMIT 1`);
      fallbackVenue = v.rows[0]?.id || null;
    }
    const targets = mgrs.rows
      .map((m) => ({ uid: m.line_uid, venueId: m.venue_id || fallbackVenue }))
      .filter((t) => t.uid && t.venueId);
    for (const t of targets) {
      try {
        await line.pushMessage(t.uid, [{ type: 'text', text }], t.venueId);
      } catch (err) {
        console.warn('[ragic-writer] LINE alert failed:', err.message);
      }
    }
  } catch (err) {
    console.warn('[ragic-writer] alert target lookup failed:', err.message);
  }
}

function createWriter(deps = {}) {
  const http = deps.http || axios.create({
    baseURL: process.env.RAGIC_BASE_URL,
    timeout: RAGIC_TIMEOUT_MS,
  });
  const audit = deps.audit || _defaultAudit;
  const alert = deps.alert || _defaultAlert;

  const reject = async (entry, err) => {
    await audit({ ...entry, status: 'rejected', reason: err.message }).catch(() => {});
    await alert(`【Ragic 寫入拒絕】${entry.sheet} field=${entry.fieldId || '(multi)'} record=${entry.recordKey || '(new)'} source=${entry.source || ''}：${err.message}`).catch(() => {});
    throw err;
  };

  const post = async (sheet, formPath, payload, meta = {}) => {
    const code = String(sheet || '').toUpperCase();
    const recordKey = meta.recordKey || recordKeyFromFormPath(formPath);
    const entry = {
      sheet: code,
      recordKey,
      fieldId: Object.keys(payload || {}).length === 1 ? _payloadFieldId(Object.keys(payload)[0]) : null,
      oldValue: meta.oldValue,
      newValue: Object.keys(payload || {}).length === 1 ? Object.values(payload)[0] : JSON.stringify(payload || {}),
      actor: meta.actor || 'system',
      source: meta.source || 'ragic-writer',
    };
    try {
      _validatePayload(code, payload);
    } catch (err) {
      return reject(entry, err);
    }
    let oldValue = entry.oldValue;
    try {
      oldValue = await _readOldValues(http, formPath, payload, { ...meta, recordKey });
      const res = await http.post(_withApi(formPath), payload, {
        params: _apiParams(meta.params || {}, meta.options || {}),
      });
      _assertWriteOk(res.data);
      await audit({ ...entry, oldValue, status: 'success', reason: null }).catch(() => {});
      return res.data || {};
    } catch (err) {
      const normalized = _normalizeRagicError(err);
      await audit({ ...entry, oldValue, status: 'error', reason: normalized.message }).catch(() => {});
      throw normalized;
    }
  };

  const del = async (sheet, formPath, recordKey, meta = {}) => {
    const code = String(sheet || '').toUpperCase();
    const entry = {
      sheet: code,
      recordKey,
      fieldId: null,
      oldValue: null,
      newValue: null,
      actor: meta.actor || 'system',
      source: meta.source || 'ragic-delete',
    };
    try {
      const res = await http.delete(_withApi(_recordPath(formPath, recordKey)), {
        params: _apiParams(meta.params || {}, meta.options || {}),
      });
      await audit({ ...entry, status: 'success', reason: null }).catch(() => {});
      return res.data || {};
    } catch (err) {
      const normalized = _normalizeRagicError(err);
      await audit({ ...entry, status: 'error', reason: normalized.message }).catch(() => {});
      throw normalized;
    }
  };

  return {
    async writeField(sheet, recordKey, fieldId, value, actor = 'system', source = 'writeField', meta = {}) {
      const form = _sheetForm(sheet);
      if (!form) throw new Error(`unknown Ragic sheet: ${sheet}`);
      if (!recordKey) throw new Error('recordKey 必填');
      return post(sheet, _recordPath(form, recordKey), { [String(fieldId)]: value }, {
        ...meta,
        recordKey,
        actor,
        source,
      });
    },
    async writeFields(sheet, recordKey, fields, actor = 'system', source = 'writeFields', meta = {}) {
      const form = _sheetForm(sheet);
      if (!form) throw new Error(`unknown Ragic sheet: ${sheet}`);
      if (!recordKey) throw new Error('recordKey 必填');
      return post(sheet, _recordPath(form, recordKey), fields, {
        ...meta,
        recordKey,
        actor,
        source,
      });
    },
    async createRecord(sheet, fields, actor = 'system', source = 'createRecord', meta = {}) {
      const form = _sheetForm(sheet);
      if (!form) throw new Error(`unknown Ragic sheet: ${sheet}`);
      return post(sheet, form, fields, { ...meta, actor, source });
    },
    async postFormPath(formPath, fields, meta = {}) {
      const sheet = meta.sheet || sheetFromFormPath(formPath);
      if (!sheet) throw new Error(`cannot infer Ragic sheet for ${formPath}`);
      return post(sheet, formPath, fields, meta);
    },
    async deleteRecord(sheet, recordKey, actor = 'system', source = 'deleteRecord', meta = {}) {
      const form = _sheetForm(sheet);
      if (!form) throw new Error(`unknown Ragic sheet: ${sheet}`);
      return del(sheet, form, recordKey, { ...meta, actor, source });
    },
    async deleteByFormPath(formPath, recordKey, meta = {}) {
      const sheet = meta.sheet || sheetFromFormPath(formPath);
      if (!sheet) throw new Error(`cannot infer Ragic sheet for ${formPath}`);
      const base = _sheetForm(sheet);
      return del(sheet, base, recordKey, meta);
    },
  };
}

const writer = createWriter();

module.exports = {
  ...writer,
  createWriter,
  normalizeLineUserId,
  sheetFromFormPath,
  recordKeyFromFormPath,
  __test__: {
    _payloadFieldId,
    _validateField,
    _validatePayload,
    _writableFields,
    _blockedFields,
  },
};
