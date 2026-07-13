'use strict';

const axios = require('axios');
const { pool } = require('../models/db');

const PROFILE_URL = 'https://api.line.me/v2/bot/profile';
const VENUE_TOKEN_ALIASES = Object.freeze({
  B: 'Xinbei',
  C: 'Songshan',
  K: 'Sanchong',
  L: 'Sanmin',
  X: 'dreams400',
});

function cleanLineUid(value) {
  return String(value || '').trim().slice(0, 100);
}

function cleanDisplayName(value) {
  return String(value || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
}

async function captureParentLineProfile({
  lineUid,
  displayName,
  source = 'LINE_LOGIN_ID_TOKEN',
  db = pool,
} = {}) {
  const uid = cleanLineUid(lineUid);
  const name = cleanDisplayName(displayName);
  if (!uid || !name) return null;
  return (await db.query(
    `INSERT INTO parent_line_profiles(line_uid,display_name,source,last_verified_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (line_uid) DO UPDATE SET
       display_name=EXCLUDED.display_name,
       source=EXCLUDED.source,
       last_verified_at=NOW(),
       updated_at=NOW()
     RETURNING line_uid,display_name,source,last_verified_at`,
    [uid, name, String(source || 'LINE_LOGIN_ID_TOKEN').slice(0, 30)]
  )).rows[0];
}

async function getCachedParentLineProfile(lineUid, db = pool) {
  const uid = cleanLineUid(lineUid);
  if (!uid) return null;
  return (await db.query(
    `SELECT line_uid,display_name,source,last_verified_at
       FROM parent_line_profiles WHERE line_uid=$1`, [uid]
  )).rows[0] || null;
}

function messagingTokensFromEnv(venueId) {
  let configured = {};
  try { configured = JSON.parse(process.env.LINE_MESSAGING_TOKENS || '{}'); } catch { configured = {}; }
  const id = String(venueId || '');
  const preferredKeys = [id, VENUE_TOKEN_ALIASES[id]].filter(Boolean);
  const values = [];
  for (const key of preferredKeys) if (configured[key]) values.push(configured[key]);
  for (const value of Object.values(configured)) if (value) values.push(value);
  return values;
}

async function messagingTokensForVenue(venueId, db = pool) {
  const values = [];
  if (venueId) {
    const local = await db.query(
      `SELECT line_token FROM admin_venues WHERE id=$1 AND COALESCE(line_token,'')<>''`,
      [String(venueId)]
    );
    if (local.rows[0]?.line_token) values.push(local.rows[0].line_token);
  }
  values.push(...messagingTokensFromEnv(venueId));
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

async function fetchDisplayNameWithToken(lineUid, token, http = axios) {
  const response = await http.get(`${PROFILE_URL}/${encodeURIComponent(lineUid)}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 3000,
    validateStatus: () => true,
  });
  if (response.status !== 200) throw new Error(`LINE_PROFILE_HTTP_${response.status}`);
  const name = cleanDisplayName(response.data?.displayName);
  if (!name) throw new Error('LINE_PROFILE_NAME_EMPTY');
  return name;
}

async function resolveParentLineDisplayName({ lineUid, venueId, force = false, db = pool, http = axios } = {}) {
  const uid = cleanLineUid(lineUid);
  if (!uid) return { displayName: '', state: 'NOT_BOUND' };
  const cached = await getCachedParentLineProfile(uid, db);
  if (cached?.display_name && !force) {
    return { displayName: cached.display_name, state: 'CACHED', source: cached.source };
  }
  const tokens = await messagingTokensForVenue(venueId, db);
  if (!tokens.length) return { displayName: cached?.display_name || '', state: 'TOKEN_UNAVAILABLE' };
  try {
    const name = await Promise.any(tokens.map((token) => fetchDisplayNameWithToken(uid, token, http)));
    const saved = await captureParentLineProfile({
      lineUid: uid, displayName: name, source: 'MESSAGING_API', db,
    });
    return { displayName: saved.display_name, state: 'FETCHED', source: saved.source };
  } catch {
    return { displayName: cached?.display_name || '', state: 'PROFILE_UNAVAILABLE' };
  }
}

module.exports = {
  captureParentLineProfile,
  getCachedParentLineProfile,
  resolveParentLineDisplayName,
  __test__: { cleanLineUid, cleanDisplayName, messagingTokensFromEnv, fetchDisplayNameWithToken },
};
