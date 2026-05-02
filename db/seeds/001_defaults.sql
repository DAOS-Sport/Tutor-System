-- Seed 001: 系統預設資料

INSERT INTO system_settings (key, value, description) VALUES
  ('sessions_per_period','6','每期課程預設堂數'),
  ('period_validity_days','365','課程有效期限（天）'),
  ('expiry_notify_days','60','到期前提前通知天數'),
  ('refund_fee_rate','0.10','退費手續費率'),
  ('transfer_fee','500','課程轉讓手續費（元）'),
  ('session_duration_minutes','60','每堂課預設時長（分鐘）'),
  ('self_cancel_hours_threshold','24','自助取消免扣堂門檻（小時）'),
  ('group_confirm_timeout_minutes','60','1對多預約同組確認逾時分鐘，逾時視為同意'),
  ('evaluation_remind_days','7','期末評鑑提醒等待天數'),
  ('mgm_experience_discount','0.50','MGM體驗課折扣係數'),
  ('mgm_full_course_discount','0.90','MGM新客戶正期折扣係數'),
  ('mgm_referrer_reward_discount','0.90','MGM推薦方獎勵折扣係數'),
  ('mgm_reward_validity_days','90','MGM推薦獎勵券有效天數'),
  ('mgm_experience_validity_days','30','MGM體驗課使用期限（天）'),
  ('senior_min_satisfaction','4.0','資深教練續聘最低整體滿意度門檻')
ON CONFLICT (key) DO NOTHING;

INSERT INTO keyword_list (keyword, category) VALUES
  ('私下加LINE','private_contact'),('LINE ID','private_contact'),('加我好友','private_contact'),
  ('私聊','private_contact'),('另外約','private_contact'),('私底下','private_contact'),('偷偷','private_contact'),
  ('私下轉帳','private_payment'),('直接匯款給我','private_payment'),('不要透過系統','private_payment'),
  ('不要讓主管知道','avoid_management')
ON CONFLICT (keyword) DO NOTHING;

INSERT INTO session_record_tags (tag_category, tag_text, auto_generated_template, is_system_default, sort_order) VALUES
  ('performance','動作標準','本堂學員動作標準，執行品質良好。',TRUE,1),
  ('performance','動作需修正','本堂部分動作需進一步修正與練習。',TRUE,2),
  ('performance','進步明顯','本堂學員進步幅度顯著，持續保持。',TRUE,3),
  ('performance','進步中','學員穩定進步中，繼續維持練習頻率。',TRUE,4),
  ('performance','體力不支','本堂學員體力較為不足，需注意恢復狀況。',TRUE,5),
  ('performance','核心需加強','核心肌群穩定性需持續加強訓練。',TRUE,6),
  ('performance','柔軟度不足','柔軟度尚有進步空間，建議加強伸展。',TRUE,7),
  ('performance','專注力佳','本堂學員專注力良好，學習效率高。',TRUE,8),
  ('performance','今日狀態良好','學員今日整體狀態良好，課程進行順暢。',TRUE,9),
  ('direction','繼續上週內容','下堂課將繼續延伸本週教學內容。',TRUE,1),
  ('direction','進入下一階段','下堂課將進入下一個學習階段。',TRUE,2),
  ('direction','複習基礎動作','下堂課將針對基礎動作進行複習與強化。',TRUE,3),
  ('direction','加強體能訓練','下堂課將加入體能強化訓練項目。',TRUE,4),
  ('direction','嘗試進階技巧','下堂課將嘗試引入進階技術動作。',TRUE,5),
  ('direction','調整訓練強度','下堂課將依學員狀況適度調整訓練強度。',TRUE,6),
  ('homework','每日15分鐘練習','請每日進行約15分鐘的自主練習。',TRUE,1),
  ('homework','指定動作3組10次','請練習今日指定動作，每次10下，共3組。',TRUE,2),
  ('homework','觀看示範影片','請觀看教練提供的動作示範影片。',TRUE,3),
  ('homework','練習呼吸節奏','請在練習中特別注意呼吸節奏的配合。',TRUE,4),
  ('homework','充分休息調養','本週建議充分休息，讓身體充分恢復。',TRUE,5)
ON CONFLICT DO NOTHING;
