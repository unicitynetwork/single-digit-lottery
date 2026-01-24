import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { gameApi } from '../api/client';
import type { BetItem } from '../api/client';

export function Home() {
  const [selectedDigits, setSelectedDigits] = useState<Record<number, number>>({});
  const [userNametag, setUserNametag] = useState('');
  const queryClient = useQueryClient();

  const { data: roundData, isLoading } = useQuery({
    queryKey: ['currentRound'],
    queryFn: () => gameApi.getCurrentRound(),
  });

  const placeBetMutation = useMutation({
    mutationFn: (bets: BetItem[]) => gameApi.placeBets(userNametag, bets),
    onSuccess: (data) => {
      const invoice = data.data.data.invoice;
      alert(`Invoice created!\nID: ${invoice.invoiceId}\nAmount: ${invoice.amount} UCT\n\nPay to confirm your bet.`);
      setSelectedDigits({});
      queryClient.invalidateQueries({ queryKey: ['currentRound'] });
    },
    onError: (error: Error) => {
      alert(`Error: ${error.message}`);
    },
  });

  const round = roundData?.data.data;

  const toggleDigit = (digit: number) => {
    setSelectedDigits((prev) => {
      if (prev[digit]) {
        const { [digit]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [digit]: 100 };
    });
  };

  const totalBet = Object.values(selectedDigits).reduce((sum, amt) => sum + amt, 0);

  const handlePlaceBet = () => {
    const bets: BetItem[] = Object.entries(selectedDigits).map(([digit, amount]) => ({
      digit: Number(digit),
      amount,
    }));
    placeBetMutation.mutate(bets);
  };

  return (
    <div className="max-w-md mx-auto p-4">
      <h1 className="text-xl font-bold text-center mb-1">Single Digit Lottery</h1>
      <p className="text-center text-gray-400 text-sm mb-4">Pick a digit, win 9x</p>

      {/* Round Info */}
      <div className="bg-white/10 rounded-lg p-3 mb-4 text-sm">
        {isLoading ? (
          <span>Loading...</span>
        ) : round ? (
          <div className="flex justify-between">
            <span>Round #{round.roundNumber}</span>
            <span className={round.status === 'open' ? 'text-green-400' : 'text-yellow-400'}>
              {round.status}
            </span>
            <span>Pool: {round.totalPool}</span>
            {round.winningDigit !== null && (
              <span className="text-yellow-400 font-bold">Won: {round.winningDigit}</span>
            )}
          </div>
        ) : null}
      </div>

      {/* Nametag */}
      <input
        type="text"
        placeholder="Your nametag"
        value={userNametag}
        onChange={(e) => setUserNametag(e.target.value)}
        className="w-full bg-white/10 border border-white/20 rounded px-3 py-2 text-sm mb-4"
      />

      {/* Digit Grid */}
      <div className="grid grid-cols-5 gap-2 mb-4">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
          <button
            key={digit}
            onClick={() => toggleDigit(digit)}
            className={`aspect-square rounded text-xl font-bold transition-all ${
              selectedDigits[digit]
                ? 'bg-purple-600 shadow-md'
                : 'bg-white/10 hover:bg-white/20'
            }`}
          >
            {digit}
          </button>
        ))}
      </div>

      {/* Selected */}
      {Object.keys(selectedDigits).length > 0 && (
        <div className="bg-white/10 rounded-lg p-3 mb-4 text-sm">
          <div className="flex flex-wrap gap-2 mb-2">
            {Object.entries(selectedDigits).map(([d, a]) => (
              <span key={d} className="bg-purple-600 px-2 py-1 rounded">
                {d}: {a}
              </span>
            ))}
          </div>
          <div className="flex justify-between text-gray-400">
            <span>Total: {totalBet}</span>
            <span>Win: {totalBet * 9}</span>
          </div>
        </div>
      )}

      {/* Bet Button */}
      <button
        disabled={!userNametag || totalBet === 0 || placeBetMutation.isPending}
        onClick={handlePlaceBet}
        className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-50 py-2 rounded font-semibold"
      >
        {placeBetMutation.isPending ? 'Placing...' : `Bet ${totalBet} UCT`}
      </button>

      {/* Nav */}
      <div className="mt-4 flex justify-center gap-4 text-sm text-purple-400">
        <Link to="/history">History</Link>
        {userNametag && <Link to={`/bets/${userNametag}`}>My Bets</Link>}
      </div>
    </div>
  );
}
