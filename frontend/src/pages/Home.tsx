import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { gameApi } from '../api/client';
import type { BetItem } from '../api/client';

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function Home() {
  const [selectedDigits, setSelectedDigits] = useState<Record<number, number>>({});
  const [userNametag, setUserNametag] = useState('');
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [nametagStatus, setNametagStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const [nametagError, setNametagError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: roundData, isLoading } = useQuery({
    queryKey: ['currentRound'],
    queryFn: () => gameApi.getCurrentRound(),
    refetchInterval: 10000,
  });

  const { data: previousRoundData } = useQuery({
    queryKey: ['previousRound'],
    queryFn: () => gameApi.getPreviousRound(),
    refetchInterval: 30000,
  });

  const placeBetMutation = useMutation({
    mutationFn: (bets: BetItem[]) => gameApi.placeBets(userNametag, bets),
    onSuccess: (data) => {
      const invoice = data.data.data.invoice;
      const betsStr = Object.entries(selectedDigits).map(([d, a]) => `#${d}: ${a}`).join(', ');
      alert(`Payment request sent!\n\nCheck your wallet for the payment request.\n\nBets: ${betsStr}\nAmount: ${invoice.amount} UCT\nInvoice ID: ${invoice.invoiceId.slice(0, 8)}...`);
      setSelectedDigits({});
      queryClient.invalidateQueries({ queryKey: ['currentRound'] });
    },
    onError: (error: unknown) => {
      const axiosError = error as { response?: { data?: { error?: string } }; message?: string };
      const message = axiosError?.response?.data?.error || axiosError?.message || 'Unknown error';
      alert(`Error: ${message}`);
    },
  });

  const round = roundData?.data.data;
  const previousRound = previousRoundData?.data.data;

  // Validate nametag with debounce
  const validateNametag = useCallback(async (nametag: string) => {
    if (!nametag || nametag.length < 2) {
      setNametagStatus('idle');
      setNametagError(null);
      return;
    }

    setNametagStatus('checking');
    setNametagError(null);

    try {
      await gameApi.validateNametag(nametag);
      setNametagStatus('valid');
      setNametagError(null);
    } catch (error: unknown) {
      setNametagStatus('invalid');
      const axiosError = error as { response?: { data?: { error?: string } } };
      setNametagError(axiosError?.response?.data?.error || 'Nametag not found');
    }
  }, []);

  // Debounced validation
  useEffect(() => {
    const timer = setTimeout(() => {
      validateNametag(userNametag);
    }, 500);

    return () => clearTimeout(timer);
  }, [userNametag, validateNametag]);

  // Timer effect
  useEffect(() => {
    if (!round?.startTime || !round?.roundDurationSeconds) return;

    const calculateRemaining = () => {
      const startTime = new Date(round.startTime).getTime();
      const endTime = startTime + round.roundDurationSeconds! * 1000;
      const now = Date.now();
      const remaining = Math.max(0, Math.floor((endTime - now) / 1000));
      return remaining;
    };

    setTimeRemaining(calculateRemaining());

    const interval = setInterval(() => {
      const remaining = calculateRemaining();
      setTimeRemaining(remaining);

      if (remaining === 0) {
        queryClient.invalidateQueries({ queryKey: ['currentRound'] });
        queryClient.invalidateQueries({ queryKey: ['previousRound'] });
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [round?.startTime, round?.roundDurationSeconds, queryClient]);

  const toggleDigit = (digit: number) => {
    setSelectedDigits((prev) => {
      if (prev[digit]) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [digit]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [digit]: 1 };
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

  const canPlaceBet = nametagStatus === 'valid' && totalBet > 0 && !placeBetMutation.isPending && round?.status === 'open';

  return (
    <div className="max-w-md mx-auto p-4">
      <h1 className="text-xl font-bold text-center mb-1">Single Digit Lottery</h1>
      <p className="text-center text-gray-400 text-sm mb-4">Pick a digit, win 9x</p>

      {/* Previous Round Winning Number */}
      {previousRound && previousRound.winningDigit !== null && (
        <div className="bg-linear-to-r from-yellow-600/20 to-orange-600/20 border border-yellow-500/30 rounded-lg p-4 mb-4 text-center">
          <p className="text-xs text-gray-400 mb-1">Previous Round #{previousRound.roundNumber} Winner</p>
          <div className="text-5xl font-bold text-yellow-400">{previousRound.winningDigit}</div>
        </div>
      )}

      {/* Timer and Round Info */}
      <div className="bg-white/10 rounded-lg p-4 mb-4">
        {isLoading ? (
          <span>Loading...</span>
        ) : round ? (
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Round #{round.roundNumber}</span>
              <span className={round.status === 'open' ? 'text-green-400' : 'text-yellow-400'}>
                {round.status}
              </span>
            </div>

            {/* Timer */}
            {round.status === 'open' && timeRemaining !== null && (
              <div className="text-center py-2">
                <p className="text-xs text-gray-400 mb-1">Time Remaining</p>
                <div className="text-3xl font-mono font-bold text-white">
                  {formatTime(timeRemaining)}
                </div>
              </div>
            )}

            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Pool</span>
              <span className="text-white font-semibold">{round.totalPool} UCT</span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Nametag with validation */}
      <div className="mb-4">
        <div className="relative">
          <input
            type="text"
            placeholder="Your nametag (e.g. alice)"
            value={userNametag}
            onChange={(e) => setUserNametag(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            className={`w-full bg-white/10 border rounded px-3 py-2 text-sm pr-10 ${
              nametagStatus === 'valid' ? 'border-green-500' :
              nametagStatus === 'invalid' ? 'border-red-500' :
              'border-white/20'
            }`}
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {nametagStatus === 'checking' && (
              <span className="text-gray-400 text-xs">...</span>
            )}
            {nametagStatus === 'valid' && (
              <span className="text-green-400 text-lg">&#10003;</span>
            )}
            {nametagStatus === 'invalid' && (
              <span className="text-red-400 text-lg">&#10007;</span>
            )}
          </div>
        </div>
        {nametagError && (
          <p className="text-red-400 text-xs mt-1">{nametagError}</p>
        )}
      </div>

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
        disabled={!canPlaceBet}
        onClick={handlePlaceBet}
        className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-50 py-2 rounded font-semibold"
      >
        {placeBetMutation.isPending ? 'Sending payment request...' : `Bet ${totalBet} UCT`}
      </button>

      {/* Nav */}
      <div className="mt-4 flex justify-center gap-4 text-sm text-purple-400">
        <Link to="/history">History</Link>
        {userNametag && nametagStatus === 'valid' && <Link to={`/bets/${userNametag}`}>My Bets</Link>}
      </div>
    </div>
  );
}
