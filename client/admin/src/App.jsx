import { Routes, Route } from 'react-router-dom';

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <div className="p-6 text-brand-primary font-bold text-xl">
            DAOS 後台（建構中）
          </div>
        }
      />
    </Routes>
  );
}
