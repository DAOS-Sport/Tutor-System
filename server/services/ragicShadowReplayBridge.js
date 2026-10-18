'use strict';

const crypto=require('node:crypto');
const {keyForVersion}=require('./ragicShadowKeys');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value==='object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,stable(value[key])]));
  }
  return value;
}
function hmac(key,value) {
  return crypto.createHmac('sha256',key).update(JSON.stringify(stable(value))).digest('hex');
}
function open(row,column) {
  if (!row || typeof row.key_version!=='string' || !Buffer.isBuffer(row.cipher_nonce)
      || row.cipher_nonce.length!==12 || !Buffer.isBuffer(row.cipher_tag) || row.cipher_tag.length!==16
      || !Buffer.isBuffer(row[column])) throw new Error('encrypted shadow row is incomplete');
  const key=keyForVersion(row.key_version);
  const cipher=crypto.createDecipheriv('aes-256-gcm',key,row.cipher_nonce);
  cipher.setAuthTag(row.cipher_tag);
  const bytes=Buffer.concat([cipher.update(row[column]),cipher.final()]);
  let value;
  try {value=JSON.parse(bytes.toString('utf8'));} catch {throw new Error('encrypted shadow JSON invalid');}
  return {key,value};
}

function decodeCheckpoint(row) {
  const {key,value:snapshot}=open(row,'encrypted_snapshot');
  if (!snapshot || typeof snapshot!=='object' || Array.isArray(snapshot)
      || snapshot.schema_version!==2 || snapshot.projection_schema_version!==1
      || !snapshot.event_manifest || typeof snapshot.event_manifest!=='object'
      || !snapshot.tables || typeof snapshot.tables!=='object'
      || hmac(key,snapshot)!==String(row.snapshot_hash || '').trim()
      || hmac(key,snapshot.event_manifest)!==String(row.event_manifest_hash || '').trim()) {
    throw new Error('shadow checkpoint hash, manifest, or schema mismatch');
  }
  if (row.previous_checkpoint_id !== undefined
      && (snapshot.previous_checkpoint_id || null)!==(row.previous_checkpoint_id || null)) {
    throw new Error('shadow checkpoint lineage mismatch');
  }
  return {snapshot,keyVersion:row.key_version};
}

function decodeJournalEvent(row) {
  const {key,value:delta}=open(row,'encrypted_delta');
  if (!delta || typeof delta!=='object' || Array.isArray(delta)
      || row.schema_version!==2 || row.hash_scope!=='changed-fields-presence-v2'
      || delta.replay_schema_version!==2 || delta.hash_scope!=='changed-fields-presence-v2'
      || !Array.isArray(delta.changed_fields) || !Array.isArray(row.changed_fields)
      || JSON.stringify([...delta.changed_fields].sort())!==JSON.stringify([...row.changed_fields].sort())
      || !delta.before_patch || !delta.after_patch
      || hmac(key,{replay_schema_version:2,hash_scope:'changed-fields-presence-v2',patch:delta.before_patch})
         !==String(row.before_hash || '').trim()
      || hmac(key,{replay_schema_version:2,hash_scope:'changed-fields-presence-v2',patch:delta.after_patch})
         !==String(row.after_hash || '').trim()) {
    throw new Error('shadow journal hash, fields, or schema mismatch');
  }
  const integer=(value)=>{const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<0)throw new Error('shadow journal numeric metadata invalid');return parsed;};
  const event={event_id:String(row.event_id),schema_version:2,hash_scope:row.hash_scope,
    commit_order:integer(row.commit_order),transaction_group:String(row.transaction_group),
    transaction_event_order:integer(row.transaction_event_order),entity_type:String(row.entity_type),
    entity_id:String(row.entity_id),local_version:integer(row.local_version),operation:String(row.operation),
    changed_fields:delta.changed_fields,before_hash:String(row.before_hash).trim(),
    after_hash:String(row.after_hash).trim(),before_patch:delta.before_patch,after_patch:delta.after_patch};
  return {event,keyVersion:row.key_version};
}
module.exports={decodeCheckpoint,decodeJournalEvent};
