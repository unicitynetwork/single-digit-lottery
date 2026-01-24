import { useState, useEffect, useCallback } from 'react';
import type { ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { gameApi } from '../api/client';
import type { BetItem } from '../api/client';
import { useCurrentRound, usePreviousRound, useRoundHistory, usePlaceBets } from '../api/hooks';
import { config } from '../config';
import './lottery.css';

type BetsState = Record<number, string>;

const DIGIT_COLORS = [
  '#ff6b6b', '#ffd700', '#00ff88', '#4ecdc4', '#a855f7',
  '#f472b6', '#fb923c', '#60a5fa', '#c084fc', '#34d399'
] as const;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function Home() {
  const [bets, setBets] = useState<BetsState>({0:'',1:'',2:'',3:'',4:'',5:'',6:'',7:'',8:'',9:''});
  const [userNametag, setUserNametag] = useState('');
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [nametagStatus, setNametagStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const [nametagError, setNametagError] = useState<string | null>(null);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const queryClient = useQueryClient();

  // Queries using custom hooks
  const { data: round, isLoading } = useCurrentRound();
  const { data: previousRound } = usePreviousRound();
  const { data: historyRounds } = useRoundHistory(config.historyLimit);

  // Mutation using custom hook
  const placeBetMutation = usePlaceBets();

  const winningHistory = historyRounds
    ?.filter(r => r.winningDigit !== null)
    .map(r => r.winningDigit as number)
    .slice(0, 12) || [];

  // Validate nametag
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
      return Math.max(0, Math.floor((endTime - now) / 1000));
    };

    const interval = setInterval(() => {
      const remaining = calculateRemaining();
      setTimeRemaining(remaining);

      if (remaining === 0) {
        queryClient.invalidateQueries({ queryKey: ['currentRound'] });
        queryClient.invalidateQueries({ queryKey: ['previousRound'] });
        queryClient.invalidateQueries({ queryKey: ['roundHistory'] });
      }
    }, 100);

    return () => clearInterval(interval);
  }, [round?.startTime, round?.roundDurationSeconds, queryClient]);

  const handleInputChange = (digit: number, value: string): void => {
    if (value === '' || /^\d{0,5}$/.test(value)) {
      setBets(prev => ({ ...prev, [digit]: value }));
    }
  };

  const handleClearAll = (): void => {
    setBets({0:'',1:'',2:'',3:'',4:'',5:'',6:'',7:'',8:'',9:''});
  };

  const handlePlaceBet = (): void => {
    if (nametagStatus !== 'valid') {
      setShowConnectModal(true);
      return;
    }

    const betItems: BetItem[] = [];
    for (let d = 0; d < 10; d++) {
      const val = parseInt(bets[d], 10);
      if (!isNaN(val) && val > 0) {
        betItems.push({ digit: d, amount: val });
      }
    }

    if (betItems.length > 0) {
      placeBetMutation.mutate(
        { userNametag, bets: betItems },
        {
          onSuccess: (data) => {
            const invoice = data.invoice;
            alert(`Payment request sent!\n\nCheck your wallet for the payment request.\n\nAmount: ${invoice.amount} ${config.tokenSymbol}\nInvoice ID: ${invoice.invoiceId.slice(0, 8)}...`);
            setBets({0:'',1:'',2:'',3:'',4:'',5:'',6:'',7:'',8:'',9:''});
          },
          onError: (error: unknown) => {
            const axiosError = error as { response?: { data?: { error?: string } }; message?: string };
            const message = axiosError?.response?.data?.error || axiosError?.message || 'Unknown error';
            alert(`Error: ${message}`);
          },
        }
      );
    }
  };

  const handleConnect = (): void => {
    setShowConnectModal(true);
  };

  const handleConnectSubmit = (): void => {
    if (nametagStatus === 'valid') {
      setShowConnectModal(false);
    }
  };

  const currentBet = Object.values(bets).reduce((sum, val) => {
    const num = parseInt(val, 10);
    return sum + ((!isNaN(num) && num > 0) ? num : 0);
  }, 0);

  const isRoundOpen = round?.status === 'open';
  const canPlaceBet = currentBet > 0 && isRoundOpen && !placeBetMutation.isPending;

  const displayDigit = previousRound?.winningDigit ?? null;
  const displayColor = displayDigit !== null ? DIGIT_COLORS[displayDigit] : '#00ff88';
  const showResult = previousRound?.winningDigit !== null;

  // Calculate potential win ratio based on pool (pari-mutuel)
  const poolSize = round?.totalPool ?? 0;

  return (
    <div className="lottery-container min-h-screen bg-linear-to-br from-[#0a0a0f] via-[#1a1a2e] to-[#0f0f1a] font-orbitron text-white relative">
      <div className="scanline" />
      <div className="grid-bg" />

      {/* Header */}
      <header className="px-8 py-2.5 flex justify-between items-center border-b border-white/5 bg-black/30 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-linear-to-br from-[#00ff88] to-[#00cc6a] rounded-lg flex items-center justify-center text-lg font-black text-[#0a0a0f] shadow-[0_0_15px_#00ff8844]">
            ?
          </div>
          <div>
            <div className="text-sm font-extrabold tracking-widest bg-linear-to-r from-[#00ff88] to-[#00ffcc] bg-clip-text text-transparent">
              {config.appName}
            </div>
            <div className="text-[8px] tracking-[3px] text-gray-500 font-rajdhani">{config.appSubtitle}</div>
          </div>
        </div>

        <nav className="flex gap-6 font-rajdhani text-[11px] font-semibold tracking-widest">
          <span className="text-[#00ff88]">PLAY</span>
          <Link to="/history" className="text-gray-500 no-underline hover:text-gray-300">HISTORY</Link>
          {userNametag && nametagStatus === 'valid' && (
            <Link to={`/bets/${userNametag}`} className="text-gray-500 no-underline hover:text-gray-300">MY BETS</Link>
          )}
        </nav>

        <button
          onClick={handleConnect}
          className={`px-4 py-2 bg-transparent border-2 rounded-full font-orbitron text-[10px] font-semibold tracking-wide cursor-pointer ${
            nametagStatus === 'valid'
              ? 'border-[#00ff88] text-[#00ff88] shadow-[0_0_10px_#00ff8833]'
              : 'border-gray-500 text-gray-500'
          }`}
        >
          {nametagStatus === 'valid' ? userNametag.toUpperCase() : 'CONNECT'}
        </button>
      </header>

      {/* Winning History */}
      <div className="py-3.5 px-8 border-b border-[#00ff8822] bg-linear-to-r from-[#00ff8808] via-transparent to-[#00ff8808] flex items-center justify-center gap-4">
        <span className="text-gray-500 text-[11px] tracking-widest font-rajdhani font-semibold">
          LAST WINNING NUMBERS
        </span>
        <div className="flex gap-2">
          {winningHistory.length > 0 ? winningHistory.map((num: number, i: number) => (
            <div
              key={i}
              className="rounded-full flex items-center justify-center text-white font-bold font-orbitron relative"
              style={{
                width: i === 0 ? 36 : 30,
                height: i === 0 ? 36 : 30,
                background: DIGIT_COLORS[num],
                fontSize: i === 0 ? 15 : 13,
                opacity: 1 - i * 0.05,
                boxShadow: i === 0 ? `0 0 15px ${DIGIT_COLORS[num]}88` : 'none'
              }}
            >
              {num}
              {i === 0 && (
                <div className="absolute -top-1.5 -right-1.5 bg-white text-black text-[7px] font-bold px-1 py-0.5 rounded-md font-rajdhani">
                  NEW
                </div>
              )}
            </div>
          )) : (
            <span className="text-gray-600 text-xs font-rajdhani">No history yet</span>
          )}
        </div>
        <span className="text-gray-600 text-[10px] font-rajdhani">← Recent</span>
      </div>

      {/* Main Content */}
      <main className="p-5 px-8 max-w-[900px] mx-auto">
        {/* Round Info & Timer */}
        <div className="text-center mb-3">
          {isLoading ? (
            <div className="text-gray-500 text-sm font-rajdhani">Loading...</div>
          ) : round ? (
            <>
              <div className="text-gray-500 text-[11px] tracking-[3px] mb-1 font-rajdhani">
                ROUND #{round.roundNumber} • {round.status.toUpperCase()} • POOL: {round.totalPool} {config.tokenSymbol}
              </div>
              {isRoundOpen && timeRemaining !== null && (
                <div className="text-5xl font-extrabold text-[#00ff88] drop-shadow-[0_0_40px_#00ff8866]">
                  {formatTime(timeRemaining)}
                </div>
              )}
              {!isRoundOpen && (
                <div className="text-3xl font-bold text-[#ffd700]">
                  {round.status === 'drawing' ? 'DRAWING...' : round.status === 'paying' ? 'PAYING OUT...' : 'ROUND CLOSED'}
                </div>
              )}
            </>
          ) : (
            <div className="text-gray-500 text-sm font-rajdhani">No active round</div>
          )}
        </div>

        {/* Spinner / Last Winner */}
        <div className="text-center mb-3">
          <div
            className="w-[170px] h-[170px] mx-auto bg-linear-to-br from-[#0a0a0f] to-[#1a1a2e] rounded-full flex items-center justify-center relative"
            style={{
              border: `4px solid ${showResult ? displayColor : '#00ff8844'}`,
              boxShadow: showResult
                ? `0 0 40px ${displayColor}66, inset 0 0 40px ${displayColor}22`
                : '0 0 40px #00ff8822, inset 0 0 40px #00000066'
            }}
          >
            <div
              className="absolute inset-2.5 rounded-full"
              style={{ border: `2px solid ${showResult ? displayColor + '44' : '#00ff8833'}` }}
            />
            <div
              className="absolute inset-[22px] rounded-full"
              style={{ border: `1px solid ${showResult ? displayColor + '22' : '#00ff8822'}` }}
            />
            <span
              className="text-[90px] font-black font-orbitron"
              style={{
                color: showResult ? displayColor : '#00ff88',
                textShadow: `0 0 40px ${showResult ? displayColor : '#00ff88'}`
              }}
            >
              {displayDigit !== null ? displayDigit : '?'}
            </span>
          </div>
          {showResult && (
            <div className="text-gray-500 text-xs font-rajdhani mt-2">
              Previous round winner
            </div>
          )}
        </div>

        <div className="h-4" />

        {/* Betting Area */}
        <div className="bg-linear-to-br from-[#0f0f1a] to-[#1a1a2e] border border-white/5 rounded-2xl p-5 mb-3">
          <div className="flex justify-between mb-4">
            <span className="text-gray-500 text-[11px] tracking-widest font-rajdhani">PLACE YOUR BETS</span>
            {currentBet > 0 && (
              <button
                onClick={handleClearAll}
                className="bg-transparent border border-[#ff6b6b44] rounded px-2.5 py-1 text-[#ff6b6b] text-[10px] cursor-pointer font-rajdhani hover:border-[#ff6b6b]"
              >
                CLEAR
              </button>
            )}
          </div>

          <div className="flex gap-2 mb-4">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => {
              const betVal = bets[digit];
              const hasBet = parseInt(betVal, 10) > 0;
              return (
                <div key={digit} className="flex-1">
                  <div
                    className="flex flex-col items-center rounded-3xl py-2 px-1 pb-2.5"
                    style={{
                      background: hasBet ? `${DIGIT_COLORS[digit]}22` : '#15151f',
                      border: `2px solid ${hasBet ? DIGIT_COLORS[digit] : '#222'}`
                    }}
                  >
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-lg font-orbitron mb-1.5"
                      style={{
                        background: DIGIT_COLORS[digit],
                        boxShadow: `0 4px 12px ${DIGIT_COLORS[digit]}44`
                      }}
                    >
                      {digit}
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={betVal}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => handleInputChange(digit, e.target.value)}
                      placeholder="0"
                      disabled={!isRoundOpen}
                      className="w-12 py-1.5 px-0.5 bg-transparent border-0 border-t border-[#333] text-sm font-bold text-center outline-none font-rajdhani placeholder:text-gray-700"
                      style={{ color: hasBet ? DIGIT_COLORS[digit] : '#666' }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-center gap-4">
            <button
              onClick={handlePlaceBet}
              disabled={!canPlaceBet}
              className={`px-10 py-3 border-0 rounded-full text-xs font-bold font-orbitron tracking-widest ${
                canPlaceBet
                  ? 'bg-linear-to-br from-[#00ff88] to-[#00cc6a] text-[#0a0a0f] cursor-pointer shadow-[0_0_20px_#00ff8866]'
                  : 'bg-[#333] text-gray-500 cursor-not-allowed'
              }`}
            >
              {placeBetMutation.isPending ? 'SENDING...' : 'PLACE BET'}
            </button>
            {currentBet > 0 && (
              <span className="text-gray-400 text-xs font-rajdhani">
                Total: <span className="text-[#ffd700] font-bold">{currentBet} {config.tokenSymbol}</span>
                <span className="text-gray-600 ml-2">
                  {poolSize > 0
                    ? `Pool: ${poolSize + currentBet} ${config.tokenSymbol}`
                    : 'Pari-mutuel'}
                </span>
              </span>
            )}
          </div>
        </div>

        {/* Pool Info */}
        <div className="bg-linear-to-br from-[#0f0f1a] to-[#1a1a2e] border border-white/5 rounded-2xl p-4 px-5">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-gray-500 text-[11px] tracking-widest font-rajdhani">CURRENT POOL</span>
              <div className="text-gray-600 text-[9px] font-rajdhani mt-0.5">
                Winners split the losers' bets
              </div>
            </div>
            <span
              className="text-lg font-bold font-orbitron"
              style={{
                color: poolSize > 0 ? '#ffd700' : '#444',
                textShadow: poolSize > 0 ? '0 0 10px #ffd70044' : 'none'
              }}
            >
              {poolSize} <span className="text-[10px] text-gray-400">{config.tokenSymbol}</span>
            </span>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="p-2 text-center text-gray-600 text-[10px] font-rajdhani border-t border-white/5">
        Powered by <span className="text-[#ffd700]">{config.tokenName}</span> • Pari-mutuel • 18+
      </footer>

      {/* Connect Modal */}
      {showConnectModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-linear-to-br from-[#0f0f1a] to-[#1a1a2e] border border-white/10 rounded-2xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-lg font-bold text-white mb-4 font-orbitron">Connect Wallet</h2>
            <p className="text-gray-400 text-sm font-rajdhani mb-4">
              Enter your Nostr nametag to connect
            </p>
            <div className="relative mb-4">
              <input
                type="text"
                placeholder="Your nametag (e.g. alice)"
                value={userNametag}
                onChange={(e) => setUserNametag(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                className={`w-full bg-black/30 border rounded-lg px-4 py-3 text-sm font-rajdhani pr-10 outline-none ${
                  nametagStatus === 'valid' ? 'border-[#00ff88]' :
                  nametagStatus === 'invalid' ? 'border-[#ff6b6b]' :
                  'border-white/20'
                }`}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                {nametagStatus === 'checking' && (
                  <span className="text-gray-400 text-xs">...</span>
                )}
                {nametagStatus === 'valid' && (
                  <span className="text-[#00ff88] text-lg">✓</span>
                )}
                {nametagStatus === 'invalid' && (
                  <span className="text-[#ff6b6b] text-lg">✗</span>
                )}
              </div>
            </div>
            {nametagError && (
              <p className="text-[#ff6b6b] text-xs font-rajdhani mb-4">{nametagError}</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setShowConnectModal(false)}
                className="flex-1 px-4 py-2 bg-transparent border border-white/20 rounded-lg text-gray-400 text-sm font-rajdhani"
              >
                Cancel
              </button>
              <button
                onClick={handleConnectSubmit}
                disabled={nametagStatus !== 'valid'}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-rajdhani font-semibold ${
                  nametagStatus === 'valid'
                    ? 'bg-[#00ff88] text-[#0a0a0f]'
                    : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                }`}
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
