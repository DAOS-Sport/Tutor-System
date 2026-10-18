'use strict';

const VERSION_RE=/^[a-z0-9][a-z0-9._-]{0,31}$/;
const HEX_RE=/^[0-9a-f]{64}$/i;

function activeKey() {
  const version=String(process.env.RAGIC_INCREMENTAL_KEY_VERSION || 'legacy-v1');
  const hex=String(process.env.RAGIC_INCREMENTAL_ENCRYPTION_KEY || '');
  if (!VERSION_RE.test(version) || !HEX_RE.test(hex)) throw new Error('active shadow key version or shape invalid');
  return {version,key:Buffer.from(hex,'hex')};
}

function keyForVersion(version) {
  if (typeof version!=='string' || !VERSION_RE.test(version)) throw new Error('invalid shadow key version');
  const active=activeKey();
  if (version===active.version) return active.key;
  const encoded=process.env.RAGIC_INCREMENTAL_OLD_KEYS_JSON;
  if (!encoded || encoded.length>4096) throw new Error('shadow key version unavailable');
  let ring;
  try {ring=JSON.parse(encoded);} catch {throw new Error('shadow keyring shape invalid');}
  if (!ring || typeof ring!=='object' || Array.isArray(ring) || Object.keys(ring).length>8
      || Object.keys(ring).some((item)=>!VERSION_RE.test(item) || !HEX_RE.test(ring[item]))) {
    throw new Error('shadow keyring shape invalid');
  }
  if (!Object.hasOwn(ring,version)) throw new Error('shadow key version unavailable');
  return Buffer.from(ring[version],'hex');
}

module.exports={activeKey,keyForVersion};
