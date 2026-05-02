/**
 * Ragic API 封裝服務
 * H01 教練 / H05 場館 → 每次即時查詢
 * Z01 家長 / Z02 學員 → 雙向同步
 */
const axios = require('axios');

const client = axios.create({
  baseURL: process.env.RAGIC_BASE_URL,
  headers: { Authorization: `Basic ${Buffer.from(process.env.RAGIC_API_KEY).toString('base64')}` },
  timeout: 10000,
});

async function query(formPath, params = {}) {
  const res = await client.get(`${formPath}?api`, { params });
  return res.data;
}

// H01：在職教練
async function getActiveCoaches() {
  const data = await query(process.env.RAGIC_FORM_H01, { '在職狀態': '在職' });
  return Object.values(data).filter(r => r['應徵職務']?.includes('教練'));
}

// H01：行政櫃檯
async function getCounterStaff() {
  const data = await query(process.env.RAGIC_FORM_H01, { '在職狀態': '在職' });
  return Object.values(data).filter(r => r['應徵職務']?.includes('行政櫃檯'));
}

// H01：全員工（角色指派用）
async function getAllStaff() {
  return Object.values(await query(process.env.RAGIC_FORM_H01));
}

// H05：場館清單（履約中，非內勤）
async function getActiveVenues() {
  const data = await query(process.env.RAGIC_FORM_H05, { '履約狀態': '履約中' });
  return Object.values(data).filter(r => r['營運性質'] !== '內勤單位');
}

// Z01：依手機查詢家長
async function getParentByPhone(phone) {
  const data = await query(process.env.RAGIC_FORM_Z01, { '行動電話': phone });
  const records = Object.values(data);
  return records[0] || null;
}

// Z01：回寫家長資料
async function upsertParent(parentData, ragicRecordId = null) {
  try {
    const path = ragicRecordId
      ? `${process.env.RAGIC_FORM_Z01}/${ragicRecordId}?api`
      : `${process.env.RAGIC_FORM_Z01}?api`;
    await client.post(path, parentData);
  } catch (err) {
    console.error('[Ragic] upsertParent failed:', err.message);
  }
}

// Z02：依身分證字號查詢學員
async function getStudentByIdNumber(idNumber) {
  const data = await query(process.env.RAGIC_FORM_Z02, { '身分證字號': idNumber });
  const records = Object.values(data);
  return records[0] || null;
}

// Z02：回寫學員資料
async function upsertStudent(studentData, ragicRecordId = null) {
  try {
    const path = ragicRecordId
      ? `${process.env.RAGIC_FORM_Z02}/${ragicRecordId}?api`
      : `${process.env.RAGIC_FORM_Z02}?api`;
    await client.post(path, studentData);
  } catch (err) {
    console.error('[Ragic] upsertStudent failed:', err.message);
  }
}

module.exports = { getActiveCoaches, getCounterStaff, getAllStaff, getActiveVenues, getParentByPhone, upsertParent, getStudentByIdNumber, upsertStudent };
