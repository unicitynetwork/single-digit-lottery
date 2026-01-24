import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { History } from './pages/History';
import { MyBets } from './pages/MyBets';

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-linear-to-br from-purple-900 via-blue-900 to-black text-white">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/history" element={<History />} />
          <Route path="/bets/:nametag" element={<MyBets />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
