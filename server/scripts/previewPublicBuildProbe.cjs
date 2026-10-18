'use strict';
// Public build-setting presence only. No dotenv, database, app or network imports.
const names=['VITE_LIFF_ID_PARENT','VITE_LIFF_ID_COACH','VITE_LIFF_ID','VITE_SUPPORT_LINE_COACH','VITE_SUPPORT_LINE_PARENT','VITE_USE_MOCK'];
const presence=Object.fromEntries(names.map(name=>[name,Boolean(process.env[name])]));
console.log(JSON.stringify({status:'PUBLIC_BUILD_METADATA',presence,parentIdAvailable:presence.VITE_LIFF_ID_PARENT||presence.VITE_LIFF_ID,coachIdAvailable:presence.VITE_LIFF_ID_COACH||presence.VITE_LIFF_ID,mockExplicitlyEnabled:process.env.VITE_USE_MOCK==='true',dotenvRead:false,databaseAccess:false,appStarted:false}));
