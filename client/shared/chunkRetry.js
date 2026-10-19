/**
 * 動態 import 失敗時的重試／重新整理策略（#15 第 3 步），由 lazyPage.jsx 使用。
 *
 * 切成多個 chunk 之後多了一種以前不存在的失敗 —— 使用者開著舊頁面時我們部署了新版，
 * 他點下一個還沒載過的頁面，瀏覽器去抓「舊版 index.html 指到的 chunk 檔名」，
 * 而新部署已經沒有那個檔案（server 端對 assets/ 缺檔誠實回 404，見
 * server/middlewares/staticFrontend.js）。單用 React.lazy 的話 promise 直接 reject，
 * 使用者只會看到錯誤頁，而且不知道「重新整理就好」。
 *
 * 所以：
 *   1. 先重試一次（行動網路瞬斷很常見，LINE 內建瀏覽器尤其如此）
 *   2. 仍然失敗、而且看起來是「chunk 載不到」→ 整頁重新整理一次，拿新版 index.html
 *   3. 用 sessionStorage 記住剛重整過；一分鐘內再失敗就不再重整，丟給錯誤邊界顯示
 *      （避免伺服器真的壞掉時陷入無限重整迴圈）。sessionStorage 不能寫就不重整。
 *
 * 這支刻意不 import 任何東西、不含 JSX：tests/route_code_splitting_test.js 直接在
 * Node 裡載入它驗行為，不需要裝前端依賴。
 */

export const RELOAD_KEY = 'daos.chunkReloadAt';
export const RELOAD_GUARD_MS = 60 * 1000;
export const RETRY_DELAY_MS = 600;

// 各瀏覽器對「動態 import 失敗」的訊息不同：Chrome／Safari／Firefox／Vite CSS 預載。
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (?:CSS )?chunk [\w-]+ failed|ChunkLoadError/i;

export function isChunkLoadError(err) {
  if (!err) return false;
  return err.name === 'ChunkLoadError' || CHUNK_ERROR.test(String(err.message || err));
}

/** 一分鐘內還沒重整過才重整；記錄失敗（隱私模式等）時寧可不重整。回傳是否已觸發重整。 */
export function reloadOnce(env) {
  try {
    const last = Number(env.storage.getItem(RELOAD_KEY)) || 0;
    if (env.now() - last < RELOAD_GUARD_MS) return false;
    env.storage.setItem(RELOAD_KEY, String(env.now()));
  } catch {
    return false;
  }
  env.reload();
  return true;
}

/**
 * @param {() => Promise<any>} importer
 * @param {{ storage, reload, now, sleep }} env  可注入，測試用；預設取瀏覽器的
 */
export async function importWithRetry(importer, env = browserEnv()) {
  try {
    return await importer();
  } catch (err) {
    if (!isChunkLoadError(err)) throw err;
    await env.sleep(RETRY_DELAY_MS);
    try {
      return await importer();
    } catch (err2) {
      // 重整中：回一個永不完成的 promise，讓 Suspense 保持在載入畫面直到頁面換掉。
      if (isChunkLoadError(err2) && reloadOnce(env)) return new Promise(() => {});
      throw err2;
    }
  }
}

function browserEnv() {
  return {
    get storage() { return window.sessionStorage; },
    reload: () => window.location.reload(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
