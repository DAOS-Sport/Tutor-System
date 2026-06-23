import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import SlotPicker from '../components/SlotPicker';

// 選擇上課時間（獨立頁）：實際選擇/預約邏輯共用 <SlotPicker>（單選）。
// 預約成功後回到上課記錄頁並預選此期，讓家長立即看到該堂變為「簽到」。
export default function SlotBookingPage() {
  const { periodId } = useParams();
  const navigate = useNavigate();
  return (
    <SlotPicker
      periodId={periodId}
      onBooked={() => navigate(`/my-lessons?period=${periodId}`, { replace: true })}
    />
  );
}
