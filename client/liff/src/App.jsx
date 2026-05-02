import { Routes, Route } from 'react-router-dom';

// Pages (to be implemented per Phase schedule)
// Phase 1: Home, CourseIntro, Enrollment
// Phase 2: SlotPicker, Checkin, CancelSession
// Phase 3: Profile, StudentManagement
// Phase 4: Chat
// Phase 5: LearningJourney, Evaluation
// Phase 6: Promotion, Referral

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<div className="p-4 text-brand-primary font-bold text-xl">DAOS 個家教課程系統</div>} />
      {/* Routes will be added per development phase */}
    </Routes>
  );
}
