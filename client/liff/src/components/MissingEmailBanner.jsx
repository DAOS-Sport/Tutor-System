import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * 首頁「請補上 Email」提醒橫幅。
 *
 * 2026-08-29 盤點：555 位在職家長裡 59 位沒有 Email（10.6%），牽連 75 位學員。
 * Ragic 的 Z01「(報)Email」是必填欄，所以這些家長：
 *   資料寫不回 Ragic、無法新增學員、每次開 App 都同步失敗。
 * 而畫面上完全看不出原因 —— 他們只覺得「系統怪怪的」。
 *
 * Email 在個人資料頁本來就是必填欄、後端 PATCH /parents/me 也早就收，
 * 家長一直都補得了；缺的只是沒有人告訴他們要去補。所以這裡不做新的表單，
 * 只做一個指路的橫幅 —— 讓 57 個家庭自己兩秒鐘解決，
 * 而不是讓櫃檯一家一家打電話。
 *
 * 沒缺 Email 就不顯示（回傳 null），與其他橫幅一致。
 */
export default function MissingEmailBanner() {
  const navigate = useNavigate();
  const { parent } = useAuth();

  if (!parent) return null;
  if (String(parent.email || '').trim()) return null;

  return (
    <section className="mb-5">
      <button
        type="button"
        onClick={() => navigate('/profile')}
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-left active:opacity-80"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xl">
            ✉️
          </span>
          <div className="min-w-0">
            <div className="text-sm font-bold text-amber-900">請補上 Email</div>
            <div className="mt-0.5 text-xs leading-5 text-amber-800">
              您的資料尚未填寫 Email，會影響報名與學員資料更新。點此補齊，只需幾秒。
            </div>
          </div>
        </div>
        <span className="shrink-0 text-amber-700">›</span>
      </button>
    </section>
  );
}

