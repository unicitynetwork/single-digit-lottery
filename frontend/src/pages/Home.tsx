import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HelpCircle, BarChart2, Dices, Target, Lightbulb, Check, X } from 'lucide-react';
import { gameApi } from '../api/client';
import type { BetItem, Round } from '../api/client';
import { useCurrentRound, usePreviousRound, useRoundHistory, usePlaceBets, useUserBetsInCurrentRound, useUserBets } from '../api/hooks';
import { config } from '../config';
import './lottery.css';

type BetsState = Record<number, string>;

const NAMETAG_KEY = 'lottery_nametag';

function loadNametag(): string {
  try {
    return localStorage.getItem(NAMETAG_KEY) || '';
  } catch {
    return '';
  }
}

function saveNametag(nametag: string): void {
  if (nametag) {
    localStorage.setItem(NAMETAG_KEY, nametag);
  } else {
    localStorage.removeItem(NAMETAG_KEY);
  }
}

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
  const [userNametag, setUserNametag] = useState(loadNametag);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [nametagStatus, setNametagStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const [nametagError, setNametagError] = useState<string | null>(null);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showMyBetsModal, setShowMyBetsModal] = useState(false);
  const [showHowToPlayModal, setShowHowToPlayModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentStep, setPaymentStep] = useState<'confirm' | 'awaiting' | 'paid' | 'failed'>('confirm');
  const [pendingBetItems, setPendingBetItems] = useState<BetItem[]>([]);
  const [pendingBetId, setPendingBetId] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [roundResult, setRoundResult] = useState<{ show: boolean; won: boolean } | null>(null);
  const [isSpinning, setIsSpinning] = useState(false);
  const [spinningDigit, setSpinningDigit] = useState<number>(0);
  const [isWaitingForDraw, setIsWaitingForDraw] = useState(false);
  const queryClient = useQueryClient();
  const prevRoundNumberRef = useRef<number | null>(null);
  const prevLockedBetsRef = useRef<Record<number, number>>({});
  const lastWinningDigitRef = useRef<number | null>(null);
  const lastPreviousRoundNumberRef = useRef<number | null>(null);
  const hasInitializedRef = useRef(false);
  const hasTriggeredDrawRef = useRef(false); // Prevent repeated triggers when timer=0
  const animationStartTimeRef = useRef<number | null>(null); // Track when animation started
  const waitingForRoundRef = useRef<number | null>(null); // Track which round we're waiting for
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]); // Refs for digit inputs

  // Queries using custom hooks
  const { data: round, isLoading } = useCurrentRound();
  const { data: previousRound } = usePreviousRound();
  const { data: historyRounds } = useRoundHistory(config.historyLimit);
  const { data: myCurrentRoundBets } = useUserBetsInCurrentRound(
    nametagStatus === 'valid' ? userNametag : undefined
  );
  // Get user's bet history to show win/loss in winning numbers
  const { data: myBetsHistory } = useUserBets(
    nametagStatus === 'valid' ? userNametag : undefined,
    config.historyLimit
  );
  // Additional hooks for modals
  const { data: allHistoryRounds, isLoading: isHistoryLoading } = useRoundHistory(50);
  const { data: userBetsHistory, isLoading: isMyBetsLoading } = useUserBets(
    nametagStatus === 'valid' ? userNametag : undefined,
    100
  );

  // Mutation using custom hook
  const placeBetMutation = usePlaceBets();

  // Create a map of roundNumber -> win result (true = won, false = lost, undefined = didn't play)
  const roundResultsMap = new Map<number, boolean>();
  if (myBetsHistory) {
    for (const bet of myBetsHistory) {
      if (bet.won !== null) {
        roundResultsMap.set(bet.roundNumber, bet.won);
      }
    }
  }

  // Get winning history with round numbers for result lookup
  const allHistoryWithRounds = historyRounds
    ?.filter(r => r.winningDigit !== null)
    .map(r => ({ digit: r.winningDigit as number, roundNumber: r.roundNumber })) || [];

  // While spinning, don't show the latest winner in history (it will appear after animation)
  const winningHistoryWithRounds = isSpinning
    ? allHistoryWithRounds.slice(1, 13)
    : allHistoryWithRounds.slice(0, 12);

  // Keep prevLockedBetsRef in sync with server data for current round
  useEffect(() => {
    if (myCurrentRoundBets && myCurrentRoundBets.length > 0) {
      const aggregated = myCurrentRoundBets.reduce<Record<number, number>>((acc, bet) => {
        bet.bets.forEach(b => {
          acc[b.digit] = (acc[b.digit] || 0) + b.amount;
        });
        return acc;
      }, {});
      prevLockedBetsRef.current = aggregated;
    }
  }, [myCurrentRoundBets]);

  // Initialize refs on first load (no animation on page load)
  // Skip if animation is already running - let landing effect handle it
  useEffect(() => {
    if (isSpinning) return; // Don't interfere with running animation
    if (!hasInitializedRef.current && previousRound?.winningDigit !== null && previousRound?.winningDigit !== undefined) {
      hasInitializedRef.current = true;
      lastWinningDigitRef.current = previousRound.winningDigit;
      lastPreviousRoundNumberRef.current = previousRound.roundNumber ?? null;
    }
  }, [previousRound?.winningDigit, previousRound?.roundNumber, isSpinning]);

  // Track round number changes - when new round starts, fetch latest data
  useEffect(() => {
    if (!round?.roundNumber) return;

    if (prevRoundNumberRef.current !== null && prevRoundNumberRef.current !== round.roundNumber) {
      // New round started! Refetch previousRound and history once
      queryClient.refetchQueries({ queryKey: ['previousRound'] });
      queryClient.refetchQueries({ queryKey: ['roundHistory'] });
    }

    prevRoundNumberRef.current = round.roundNumber;
  }, [round?.roundNumber, queryClient]);

  // Spinning effect - runs random digits while isSpinning is true
  useEffect(() => {
    if (!isSpinning) return;

    const spinInterval = setInterval(() => {
      setSpinningDigit(Math.floor(Math.random() * 10));
    }, 100);

    return () => clearInterval(spinInterval);
  }, [isSpinning]);

  // Landing effect - lands on winning digit when we have it AND min 2 seconds have passed
  useEffect(() => {
    if (!isSpinning) return;

    const winningDigit = previousRound?.winningDigit;
    const prevRoundNumber = previousRound?.roundNumber;

    console.log('[Landing] isSpinning:', isSpinning, 'prevRound#:', prevRoundNumber, 'winningDigit:', winningDigit, 'waitingFor:', waitingForRoundRef.current);

    // No winning digit yet - keep spinning
    if (winningDigit === null || winningDigit === undefined) {
      console.log('[Landing] No winning digit yet, keep spinning');
      return;
    }

    // Check if this is the round we're waiting for
    // If we're waiting for a specific round and this isn't it, keep spinning
    if (waitingForRoundRef.current !== null && prevRoundNumber !== waitingForRoundRef.current) {
      console.log('[Landing] Round mismatch! Got #', prevRoundNumber, 'but waiting for #', waitingForRoundRef.current);
      return;
    }

    // Calculate remaining time to reach minimum 2 seconds
    const startTime = animationStartTimeRef.current || Date.now();
    const elapsed = Date.now() - startTime;
    const minAnimationTime = 2000;
    const remainingTime = Math.max(0, minAnimationTime - elapsed);

    // Wait for remaining time, then land on winning digit
    const timer = setTimeout(() => {
      setSpinningDigit(winningDigit);
      setIsSpinning(false);
      setIsWaitingForDraw(false);

      // Update refs
      hasInitializedRef.current = true;
      lastWinningDigitRef.current = winningDigit;
      lastPreviousRoundNumberRef.current = prevRoundNumber ?? null;
      waitingForRoundRef.current = null; // Clear waiting state

      // Refetch all data after round ends
      queryClient.refetchQueries({ queryKey: ['currentRound'] });
      queryClient.refetchQueries({ queryKey: ['roundHistory'] });
      queryClient.refetchQueries({ queryKey: ['userBetsCurrentRound'] });
      queryClient.refetchQueries({ queryKey: ['userBets'] });

      // Show win/loss result
      const savedBets = prevLockedBetsRef.current;
      const hadBets = Object.values(savedBets).some(v => v > 0);
      if (hadBets) {
        const betOnWinner = savedBets[winningDigit] || 0;
        setRoundResult({ show: true, won: betOnWinner > 0 });
        setTimeout(() => setRoundResult(null), 5000);
      }

      prevLockedBetsRef.current = {};
    }, remainingTime);

    return () => clearTimeout(timer);
  }, [isSpinning, previousRound?.winningDigit, previousRound?.roundNumber, queryClient]);

  // Poll for payment confirmation
  useEffect(() => {
    if (!pendingBetId || paymentStep !== 'awaiting') return;

    let pollCount = 0;
    const maxPolls = 60; // 60 polls * 2 seconds = 2 minutes timeout

    const pollInterval = setInterval(async () => {
      pollCount++;

      try {
        // First try current round
        const response = await gameApi.getUserBetsInCurrentRound(userNametag);
        const currentBets = response.data.data;
        let pendingBet = currentBets.find(b => b._id === pendingBetId);

        // If not found in current round, check user's bet history (round may have closed)
        if (!pendingBet) {
          const historyResponse = await gameApi.getUserBets(userNametag, 10);
          const historyBets = historyResponse.data.data;
          pendingBet = historyBets.find(b => b._id === pendingBetId);
        }

        if (pendingBet) {
          if (pendingBet.paymentStatus === 'paid') {
            // Payment confirmed!
            clearInterval(pollInterval);
            setPaymentStep('paid');
            queryClient.invalidateQueries({ queryKey: ['userBetsCurrentRound'] });
            queryClient.invalidateQueries({ queryKey: ['currentRound'] });
            // Close modal after showing success
            setTimeout(() => {
              setShowPaymentModal(false);
              setPendingBetItems([]);
              setPendingBetId(null);
              setPaymentStep('confirm');
            }, 1500);
          } else if (pendingBet.paymentStatus === 'expired' || pendingBet.paymentStatus === 'failed' || pendingBet.paymentStatus === 'refunded') {
            // Payment failed or refunded
            clearInterval(pollInterval);
            setPaymentStep('failed');
            setPaymentError(
              pendingBet.paymentStatus === 'expired'
                ? 'Payment expired. Please try again.'
                : pendingBet.paymentStatus === 'refunded'
                ? 'Round closed. Payment refunded to your wallet.'
                : 'Payment failed. Please try again.'
            );
          }
          // If still 'pending', continue polling
        }
      } catch {
        // Ignore polling errors, continue trying
      }

      // Timeout check
      if (pollCount >= maxPolls) {
        clearInterval(pollInterval);
        setPaymentStep('failed');
        setPaymentError('Payment timeout. Check your wallet and try again.');
      }
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(pollInterval);
  }, [pendingBetId, paymentStep, userNametag, queryClient]);

  // Polling for previousRound when waiting for draw result
  useEffect(() => {
    // Only poll while spinning (waiting for result)
    if (!isSpinning) return;

    // Poll every 500ms to get the winning digit until we land
    const pollInterval = setInterval(() => {
      console.log('[Polling] Fetching previousRound...');
      queryClient.refetchQueries({ queryKey: ['previousRound'] });
    }, 500);

    return () => clearInterval(pollInterval);
  }, [isSpinning, queryClient]);

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

    // Reset the draw trigger for new round
    hasTriggeredDrawRef.current = false;

    const calculateRemaining = () => {
      const startTime = new Date(round.startTime).getTime();
      const endTime = startTime + round.roundDurationSeconds! * 1000;
      const now = Date.now();
      return Math.max(0, Math.floor((endTime - now) / 1000));
    };

    // Set initial value immediately
    const initialRemaining = calculateRemaining();
    setTimeRemaining(initialRemaining);

    // If loading page with timer already at 0, trigger draw state once
    if (initialRemaining === 0 && !hasTriggeredDrawRef.current && round?.roundNumber) {
      hasTriggeredDrawRef.current = true;
      setIsWaitingForDraw(true);
      setIsSpinning(true);
      animationStartTimeRef.current = Date.now();
      waitingForRoundRef.current = round.roundNumber; // We're waiting for THIS round's result
      queryClient.refetchQueries({ queryKey: ['previousRound'] });
    }

    const interval = setInterval(() => {
      const remaining = calculateRemaining();
      setTimeRemaining(remaining);

      // When timer hits 0, start animation immediately
      if (remaining === 0 && !hasTriggeredDrawRef.current && round?.roundNumber) {
        hasTriggeredDrawRef.current = true;
        setIsWaitingForDraw(true);
        setIsSpinning(true);
        animationStartTimeRef.current = Date.now();
        waitingForRoundRef.current = round.roundNumber; // We're waiting for THIS round's result
        queryClient.refetchQueries({ queryKey: ['previousRound'] });
      }
    }, 500);

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
      // Show confirmation modal instead of placing bet directly
      setPendingBetItems(betItems);
      setPaymentStep('confirm');
      setShowPaymentModal(true);
    }
  };

  const handleConfirmBet = (): void => {
    if (pendingBetItems.length === 0) return;

    setPaymentStep('awaiting');
    setPaymentError(null);

    placeBetMutation.mutate(
      { userNametag, bets: pendingBetItems },
      {
        onSuccess: (data) => {
          // Store the bet ID for polling
          setPendingBetId(data.bet._id);
          // Clear the input fields
          setBets({0:'',1:'',2:'',3:'',4:'',5:'',6:'',7:'',8:'',9:''});
          // The polling effect will handle closing the modal when payment is confirmed
        },
        onError: (error: unknown) => {
          const axiosError = error as { response?: { data?: { error?: string } }; message?: string };
          const message = axiosError?.response?.data?.error || axiosError?.message || 'Unknown error';
          // Show error in modal
          setPaymentStep('failed');
          setPaymentError(message);
        },
      }
    );
  };

  const handleCancelBet = (): void => {
    setShowPaymentModal(false);
    setPendingBetItems([]);
    setPendingBetId(null);
    setPaymentStep('confirm');
    setPaymentError(null);
  };

  const handleConnect = (): void => {
    setShowConnectModal(true);
  };

  const handleConnectSubmit = (): void => {
    if (nametagStatus === 'valid') {
      saveNametag(userNametag);
      setShowConnectModal(false);
    }
  };

  const handleDisconnect = (): void => {
    saveNametag('');
    setUserNametag('');
    setNametagStatus('idle');
    setNametagError(null);
  };

  const currentBet = Object.values(bets).reduce((sum, val) => {
    const num = parseInt(val, 10);
    return sum + ((!isNaN(num) && num > 0) ? num : 0);
  }, 0);

  // Aggregate bets from database for current round
  const myBetsAggregated = (myCurrentRoundBets || []).reduce<Record<number, number>>((acc, bet) => {
    bet.bets.forEach(b => {
      acc[b.digit] = (acc[b.digit] || 0) + b.amount;
    });
    return acc;
  }, {});
  const totalMyBets = Object.values(myBetsAggregated).reduce((sum, val) => sum + val, 0);

  const isRoundOpen = round?.status === 'open';
  const canPlaceBet = currentBet > 0 && isRoundOpen && !placeBetMutation.isPending;

  // Show spinning digit during animation, otherwise show winning digit
  const actualWinningDigit = previousRound?.winningDigit ?? null;
  const displayDigit = isSpinning ? spinningDigit : actualWinningDigit;
  const displayColor = displayDigit !== null ? DIGIT_COLORS[displayDigit] : '#00ff88';
  const showResult = actualWinningDigit !== null;

  return (
    <div className="lottery-container min-h-screen flex flex-col bg-linear-to-br from-[#0a0a0f] via-[#1a1a2e] to-[#0f0f1a] font-orbitron text-white relative overflow-x-hidden">
      <div className="scanline" />
      <div className="grid-bg" />

      {/* Header */}
      <header className="px-4 md:px-8 py-2.5 flex justify-between items-center border-b border-white/5 bg-black/30 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-linear-to-br from-[#00ff88] to-[#00cc6a] rounded-lg flex items-center justify-center text-lg font-black text-[#0a0a0f] shadow-[0_0_15px_#00ff8844]">
            ?
          </div>
          <div>
            <div className="text-sm font-extrabold tracking-widest bg-linear-to-r from-[#00ff88] to-[#00ffcc] bg-clip-text text-transparent">
              {config.appName}
            </div>
            <div className="text-[10px] tracking-[3px] text-gray-500 font-rajdhani">{config.appSubtitle}</div>
          </div>
        </div>

        {nametagStatus === 'valid' ? (
          <div className="flex items-center gap-2">
            <span className="px-4 py-2 border-2 border-[#00ff88] text-[#00ff88] rounded-full font-orbitron text-xs font-semibold tracking-wide shadow-[0_0_10px_#00ff8833]">
              {userNametag.toUpperCase()}
            </span>
            <button
              onClick={handleDisconnect}
              className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-[#ff6b6b] hover:border-[#ff6b6b] border border-gray-600 rounded-full transition-colors"
              title="Disconnect"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={handleConnect}
            className="px-4 py-2 bg-transparent border-2 border-gray-500 text-gray-500 rounded-full font-orbitron text-xs font-semibold tracking-wide cursor-pointer hover:border-gray-400 hover:text-gray-400 transition-colors"
          >
            CONNECT
          </button>
        )}
      </header>

      {/* Winning History */}
      <div className="py-2.5 md:py-3.5 px-4 md:px-8 border-b border-[#00ff8822] bg-linear-to-r from-[#00ff8808] via-transparent to-[#00ff8808] flex items-center justify-center gap-2 md:gap-4 flex-wrap">
        <span className="text-gray-500 text-xs md:text-sm tracking-widest font-rajdhani font-semibold">
          LAST WINNERS
        </span>
        <div className="flex gap-1.5 md:gap-2 flex-wrap justify-center">
          {winningHistoryWithRounds.length > 0 ? winningHistoryWithRounds.slice(0, 8).map((item, i) => {
            const result = roundResultsMap.get(item.roundNumber);
            const isWin = result === true;
            const played = result !== undefined;

            return (
              <div
                key={i}
                className="rounded-full flex items-center justify-center text-white font-bold font-orbitron relative shrink-0"
                style={{
                  width: i === 0 ? 32 : 26,
                  height: i === 0 ? 32 : 26,
                  background: DIGIT_COLORS[item.digit],
                  fontSize: i === 0 ? 14 : 12,
                  opacity: 1 - i * 0.06,
                  boxShadow: i === 0
                    ? `0 0 15px ${DIGIT_COLORS[item.digit]}88`
                    : played
                      ? isWin
                        ? '0 0 8px #00ff88'
                        : '0 0 8px #ff4444'
                      : 'none',
                  outline: played
                    ? isWin
                      ? '2px solid #00ff88'
                      : '2px solid #ff4444'
                    : 'none',
                  outlineOffset: '2px'
                }}
              >
                {item.digit}
                {i === 0 && (
                  <div className="absolute -top-1 -right-1 bg-white text-black text-[6px] font-bold px-0.5 py-0.5 rounded font-rajdhani leading-none">
                    NEW
                  </div>
                )}
                {/* Win/Loss indicator for played rounds */}
                {played && i !== 0 && (
                  <div
                    className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full flex items-center justify-center text-[6px] font-bold ${
                      isWin ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
                    }`}
                  >
                    {isWin ? '✓' : '✗'}
                  </div>
                )}
              </div>
            );
          }) : (
            <span className="text-gray-600 text-xs font-rajdhani">No history yet</span>
          )}
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 p-3 md:p-4 px-4 md:px-8 max-w-225 mx-auto w-full">
        {/* Round Info & Timer */}
        <div className="text-center mb-2">
          {isLoading ? (
            <div className="text-gray-500 text-sm font-rajdhani">Loading...</div>
          ) : round ? (
            <>
              <div className="text-gray-500 text-sm tracking-[3px] mb-1 font-rajdhani">
                ROUND #{round.roundNumber} • {round.status.toUpperCase()} • POOL: {round.totalPool} {config.tokenSymbol}
              </div>
              {isRoundOpen && timeRemaining !== null && !isWaitingForDraw && !isSpinning && (
                <div className="text-5xl font-extrabold text-[#00ff88] drop-shadow-[0_0_40px_#00ff8866]">
                  {formatTime(timeRemaining)}
                </div>
              )}
              {(isWaitingForDraw || isSpinning) && (
                <div className="text-5xl font-extrabold text-[#ffd700] drop-shadow-[0_0_40px_#ffd70066] animate-pulse">
                  DRAWING...
                </div>
              )}
              {!isRoundOpen && !isWaitingForDraw && !isSpinning && (
                <div className="text-5xl font-extrabold text-[#ffd700] drop-shadow-[0_0_40px_#ffd70066]">
                  {round.status === 'drawing' ? 'DRAWING...' : round.status === 'paying' ? 'PAYING OUT...' : 'CLOSED'}
                </div>
              )}
            </>
          ) : (
            <div className="text-gray-500 text-sm font-rajdhani">No active round</div>
          )}
        </div>

        {/* Spinner / Last Winner */}
        <div className="text-center mb-2">
          <div
            className="w-36 h-36 md:w-42.5 md:h-42.5 mx-auto bg-linear-to-br from-[#0a0a0f] to-[#1a1a2e] rounded-full flex items-center justify-center relative"
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
              className="absolute inset-5.5 rounded-full"
              style={{ border: `1px solid ${showResult ? displayColor + '22' : '#00ff8822'}` }}
            />
            <span
              className="text-[70px] md:text-[90px] font-black font-orbitron"
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

        {/* Round Result - fixed height to prevent layout jump */}
        <div className="h-8 md:h-12 flex items-center justify-center mb-1">
          {roundResult?.show && (
            <div className="text-center">
              {roundResult.won ? (
                <div className="text-2xl font-extrabold text-[#00ff88] drop-shadow-[0_0_20px_#00ff88]">
                  YOU WIN!
                </div>
              ) : (
                <div className="text-xl font-bold text-[#ff4444]">Better luck next time!</div>
              )}
            </div>
          )}
        </div>

        {/* Betting Area */}
        <div className="bg-linear-to-br from-[#0f0f1a] to-[#1a1a2e] border border-white/5 rounded-2xl p-3 md:p-5 mb-2">
          <div className="flex justify-between items-center mb-4">
            <span className="text-gray-500 text-sm tracking-widest font-rajdhani">PLACE YOUR BETS</span>
            {currentBet > 0 && (
              <button
                onClick={handleClearAll}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#ff6b6b]/10 border border-[#ff6b6b]/30 rounded-lg text-[#ff6b6b] text-xs font-rajdhani font-semibold tracking-wide hover:bg-[#ff6b6b]/20 hover:border-[#ff6b6b]/50 transition-all"
              >
                <X size={14} /> CLEAR
              </button>
            )}
          </div>

          {/* Mobile: 2 rows of 5 digits, Desktop: single row of 10 */}
          <div className="grid grid-cols-5 md:grid-cols-10 gap-2 md:gap-2 mb-4">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => {
              const betVal = bets[digit];
              const hasBet = parseInt(betVal, 10) > 0;
              return (
                <div key={digit}>
                  <div
                    className="flex flex-col items-center rounded-2xl md:rounded-3xl py-2 md:py-2 px-1 md:px-1 pb-2 cursor-pointer"
                    onClick={() => inputRefs.current[digit]?.focus()}
                    style={{
                      background: hasBet ? `${DIGIT_COLORS[digit]}22` : '#15151f',
                      border: `2px solid ${hasBet ? DIGIT_COLORS[digit] : '#222'}`
                    }}
                  >
                    <div
                      className="w-9 h-9 md:w-10 md:h-10 rounded-full flex items-center justify-center text-white font-bold text-base md:text-lg font-orbitron mb-1.5"
                      style={{
                        background: DIGIT_COLORS[digit],
                        boxShadow: `0 4px 12px ${DIGIT_COLORS[digit]}44`
                      }}
                    >
                      {digit}
                    </div>
                    <input
                      ref={el => { inputRefs.current[digit] = el; }}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={betVal}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => handleInputChange(digit, e.target.value)}
                      placeholder="0"
                      disabled={!isRoundOpen}
                      className="w-full py-2 md:py-1.5 px-1 bg-transparent border-0 border-t border-[#333] text-sm md:text-sm font-bold text-center outline-none font-rajdhani placeholder:text-gray-700"
                      style={{ color: hasBet ? DIGIT_COLORS[digit] : '#666' }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-center">
            <button
              onClick={handlePlaceBet}
              disabled={!canPlaceBet}
              className={`px-8 md:px-10 py-2.5 md:py-3 border-0 rounded-full text-xs md:text-sm font-bold font-orbitron tracking-widest ${
                canPlaceBet
                  ? 'bg-linear-to-br from-[#00ff88] to-[#00cc6a] text-[#0a0a0f] cursor-pointer shadow-[0_0_20px_#00ff8866]'
                  : 'bg-[#333] text-gray-500 cursor-not-allowed'
              }`}
            >
              {placeBetMutation.isPending
                ? 'SENDING...'
                : currentBet > 0
                  ? `BET ${currentBet} ${config.tokenSymbol}`
                  : 'PLACE BET'
              }
            </button>
          </div>
        </div>

        {/* My Bets This Round */}
        <div className="bg-linear-to-br from-[#0f0f1a] to-[#1a1a2e] border border-white/5 rounded-2xl p-3 md:p-4 px-4 md:px-5">
          <div className="flex justify-between items-center mb-3">
            <span className="text-gray-500 text-sm tracking-widest font-rajdhani">MY BETS THIS ROUND</span>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 text-sm font-rajdhani">TOTAL:</span>
              <span
                className="text-lg font-bold font-orbitron"
                style={{
                  color: totalMyBets > 0 ? '#ffd700' : '#444',
                  textShadow: totalMyBets > 0 ? '0 0 10px #ffd70044' : 'none'
                }}
              >
                {totalMyBets} <span className="text-xs text-gray-400">{config.tokenSymbol}</span>
              </span>
            </div>
          </div>

          {totalMyBets > 0 ? (
            <div className="grid grid-cols-5 md:grid-cols-10 gap-2">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => {
                const total = myBetsAggregated[digit] || 0;
                return (
                  <div
                    key={digit}
                    className="text-center"
                    style={{ opacity: total > 0 ? 1 : 0.3 }}
                  >
                    <div
                      className="w-9 h-9 md:w-8 md:h-8 mx-auto mb-1 rounded-full flex items-center justify-center font-bold text-sm md:text-[13px] font-orbitron"
                      style={{
                        background: total > 0 ? DIGIT_COLORS[digit] : '#1a1a2e',
                        color: total > 0 ? '#fff' : '#444',
                        boxShadow: total > 0 ? `0 0 10px ${DIGIT_COLORS[digit]}66` : 'none',
                        border: total > 0 ? 'none' : '1px solid #333'
                      }}
                    >
                      {digit}
                    </div>
                    <div
                      className="text-sm md:text-xs font-bold font-rajdhani"
                      style={{ color: total > 0 ? DIGIT_COLORS[digit] : '#333' }}
                    >
                      {total > 0 ? total : '-'}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : nametagStatus === 'valid' ? (
            <div className="text-gray-600 text-sm text-center py-3 font-rajdhani">
              No bets placed yet
            </div>
          ) : (
            <div className="text-gray-600 text-sm text-center py-3 font-rajdhani">
              Connect wallet to see your bets
            </div>
          )}
        </div>

        </main>

      {/* Footer */}
      <footer className="py-2 md:py-3 px-3 md:px-8 flex items-center justify-between border-t border-white/5">
        <div className="flex items-center gap-1.5 sm:gap-2 flex-1 min-w-0">
          <button
            onClick={() => setShowHowToPlayModal(true)}
            className="flex items-center justify-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 md:px-4 py-1.5 md:py-2 bg-white/5 border border-white/10 rounded-lg text-gray-400 text-[11px] sm:text-xs md:text-sm font-rajdhani font-semibold tracking-wide hover:bg-white/10 hover:text-white hover:border-white/20 transition-all"
          >
            <HelpCircle size={14} className="shrink-0" /> <span className="sm:hidden">?</span><span className="hidden sm:inline">HOW TO PLAY</span>
          </button>
          <button
            onClick={() => setShowHistoryModal(true)}
            className="flex items-center justify-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 md:px-4 py-1.5 md:py-2 bg-white/5 border border-white/10 rounded-lg text-gray-400 text-[11px] sm:text-xs md:text-sm font-rajdhani font-semibold tracking-wide hover:bg-white/10 hover:text-white hover:border-white/20 transition-all"
          >
            <BarChart2 size={14} className="shrink-0" /> HISTORY
          </button>
          {userNametag && nametagStatus === 'valid' && (
            <button
              onClick={() => setShowMyBetsModal(true)}
              className="flex items-center justify-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 md:px-4 py-1.5 md:py-2 bg-white/5 border border-white/10 rounded-lg text-gray-400 text-[11px] sm:text-xs md:text-sm font-rajdhani font-semibold tracking-wide hover:bg-white/10 hover:text-white hover:border-white/20 transition-all"
            >
              <Dices size={14} className="shrink-0" /> BETS
            </button>
          )}
        </div>
        <div className="text-gray-600 text-[10px] sm:text-xs md:text-sm font-rajdhani shrink-0 ml-2">
          <span className="text-[#ffd700]">{config.tokenName}</span> <span className="hidden sm:inline">• 18+</span>
        </div>
      </footer>

      {/* Connect Modal */}
      {showConnectModal && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md flex items-center justify-center z-50">
          {/* Modal Container */}
          <div
            className="relative w-full max-w-md mx-4 bg-linear-to-br from-[#0a0a0f] via-[#12121a] to-[#0a0a0f] rounded-2xl overflow-hidden"
            style={{
              boxShadow: '0 0 60px #00ff8822, 0 0 100px #00ff8811, inset 0 1px 0 #ffffff08'
            }}
          >
            {/* Glowing border */}
            <div
              className="absolute inset-0 rounded-2xl pointer-events-none"
              style={{
                border: '1px solid #00ff8844',
                boxShadow: 'inset 0 0 20px #00ff8811'
              }}
            />

            {/* Grid background */}
            <div
              className="absolute inset-0 opacity-10 pointer-events-none"
              style={{
                backgroundImage: 'linear-gradient(#00ff8808 1px, transparent 1px), linear-gradient(90deg, #00ff8808 1px, transparent 1px)',
                backgroundSize: '20px 20px'
              }}
            />

            {/* Header */}
            <div className="relative px-6 pt-5 pb-4 border-b border-[#00ff8822]">
              <button
                onClick={() => setShowConnectModal(false)}
                className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center text-gray-600 hover:text-white transition-colors rounded-full hover:bg-white/5"
              >
                <X size={18} />
              </button>

              <div className="flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center text-lg"
                  style={{
                    background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
                    boxShadow: '0 0 15px #00ff8844'
                  }}
                >
                  <span className="text-[#0a0a0f] font-black">?</span>
                </div>
                <div>
                  <h2 className="text-sm font-extrabold text-white font-orbitron tracking-widest">
                    CONNECT
                  </h2>
                  <p className="text-[10px] text-gray-500 font-rajdhani tracking-[3px]">
                    NOSTR IDENTITY
                  </p>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="relative px-6 py-5">
              <p className="text-gray-500 text-sm font-rajdhani mb-5">
                Enter your Nostr nametag to connect your wallet and start playing.
              </p>

              {/* Input Field */}
              <div className="mb-4">
                <label className="block text-sm text-gray-500 font-rajdhani tracking-widest mb-2">
                  NAMETAG
                </label>
                <div className="relative">
                  <div
                    className="absolute inset-0 rounded-xl pointer-events-none transition-all duration-300"
                    style={{
                      boxShadow: nametagStatus === 'valid'
                        ? '0 0 20px #00ff8833, inset 0 0 20px #00ff8811'
                        : nametagStatus === 'invalid'
                        ? '0 0 20px #ff6b6b33, inset 0 0 20px #ff6b6b11'
                        : 'none'
                    }}
                  />
                  <input
                    type="text"
                    placeholder="alice"
                    value={userNametag}
                    onChange={(e) => setUserNametag(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                    className={`w-full bg-[#0a0a0f] rounded-xl px-4 py-3 text-sm font-rajdhani font-semibold pr-12 outline-none transition-all duration-300 ${
                      nametagStatus === 'valid' ? 'border-2 border-[#00ff88] text-[#00ff88]' :
                      nametagStatus === 'invalid' ? 'border-2 border-[#ff6b6b] text-[#ff6b6b]' :
                      'border-2 border-[#222] text-white focus:border-[#00ff8866]'
                    }`}
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2">
                    {nametagStatus === 'checking' && (
                      <div className="w-5 h-5 border-2 border-gray-600 border-t-[#00ff88] rounded-full animate-spin" />
                    )}
                    {nametagStatus === 'valid' && (
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-[#0a0a0f]"
                        style={{
                          background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
                          boxShadow: '0 0 10px #00ff8866'
                        }}
                      >
                        <Check size={14} strokeWidth={3} />
                      </div>
                    )}
                    {nametagStatus === 'invalid' && (
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-white"
                        style={{
                          background: 'linear-gradient(135deg, #ff6b6b 0%, #cc4444 100%)',
                          boxShadow: '0 0 10px #ff6b6b66'
                        }}
                      >
                        <X size={14} strokeWidth={3} />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Error Message */}
              {nametagError && (
                <div
                  className="mb-4 px-3 py-2.5 rounded-lg text-[#ff6b6b] text-sm font-rajdhani"
                  style={{
                    background: '#ff6b6b11',
                    border: '1px solid #ff6b6b33'
                  }}
                >
                  {nametagError}
                </div>
              )}

              {/* Success State Info */}
              {nametagStatus === 'valid' && (
                <div
                  className="mb-4 px-3 py-2.5 rounded-lg text-[#00ff88] text-sm font-rajdhani flex items-center gap-2"
                  style={{
                    background: '#00ff8811',
                    border: '1px solid #00ff8833'
                  }}
                >
                  <Check size={16} /> Nametag verified on Nostr network
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="relative px-6 pb-6 flex gap-3">
              <button
                onClick={() => setShowConnectModal(false)}
                className="flex-1 px-4 py-3 bg-transparent border-2 border-[#333] rounded-xl text-gray-400 text-sm font-orbitron font-semibold tracking-widest hover:border-[#444] hover:text-gray-300 transition-all"
              >
                CANCEL
              </button>
              <button
                onClick={handleConnectSubmit}
                disabled={nametagStatus !== 'valid'}
                className={`flex-1 px-4 py-3 rounded-xl text-sm font-orbitron font-bold tracking-widest transition-all ${
                  nametagStatus === 'valid'
                    ? 'text-[#0a0a0f] cursor-pointer'
                    : 'bg-[#1a1a2e] text-gray-600 cursor-not-allowed border-2 border-[#222]'
                }`}
                style={nametagStatus === 'valid' ? {
                  background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
                  boxShadow: '0 0 30px #00ff8844, 0 4px 15px #00ff8833'
                } : {}}
              >
                CONNECT
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History Modal */}
      {showHistoryModal && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-end justify-center" onClick={() => setShowHistoryModal(false)}>
          <div
            className="w-full max-w-2xl max-h-[70vh] bg-linear-to-br from-[#0a0a0f] via-[#12121a] to-[#0a0a0f] rounded-t-2xl flex flex-col animate-slide-up relative overflow-hidden"
            onClick={e => e.stopPropagation()}
            style={{
              boxShadow: '0 0 60px #00ff8822, inset 0 1px 0 #ffffff08'
            }}
          >
            {/* Glowing border */}
            <div
              className="absolute inset-0 rounded-t-2xl pointer-events-none"
              style={{ border: '1px solid #00ff8844', borderBottom: 'none' }}
            />

            {/* Grid background */}
            <div
              className="absolute inset-0 opacity-5 pointer-events-none"
              style={{
                backgroundImage: 'linear-gradient(#00ff8808 1px, transparent 1px), linear-gradient(90deg, #00ff8808 1px, transparent 1px)',
                backgroundSize: '30px 30px'
              }}
            />

            {/* Header */}
            <div className="relative px-5 py-4 flex items-center justify-between border-b border-[#00ff8822]">
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
                    boxShadow: '0 0 15px #00ff8844'
                  }}
                >
                  <BarChart2 size={16} className="text-[#0a0a0f]" />
                </div>
                <div className="leading-tight">
                  <span className="text-lg font-bold text-white font-orbitron tracking-widest block">HISTORY</span>
                  <p className="text-xs text-gray-500 font-rajdhani tracking-wider -mt-0.5">PAST ROUNDS</p>
                </div>
              </div>
              <button
                onClick={() => setShowHistoryModal(false)}
                className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content */}
            <div className="relative px-4 py-4 overflow-y-auto flex-1">
              {isHistoryLoading ? (
                <div className="text-center py-8 text-gray-500 text-sm font-rajdhani">Loading...</div>
              ) : !allHistoryRounds || allHistoryRounds.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm font-rajdhani">No completed rounds yet</div>
              ) : (
                <div className="space-y-2">
                  {allHistoryRounds.map((r, index) => (
                    <div
                      key={r._id}
                      className="flex items-center gap-4 px-4 py-3 rounded-xl relative group"
                      style={{
                        background: index === 0 ? 'linear-gradient(135deg, #00ff8808 0%, transparent 100%)' : 'rgba(255,255,255,0.02)',
                        border: index === 0 ? '1px solid #00ff8833' : '1px solid transparent'
                      }}
                    >
                      {/* Round number */}
                      <div className="flex flex-col items-center w-12 shrink-0">
                        <span className="text-[10px] text-gray-600 font-rajdhani uppercase tracking-wider">Round</span>
                        <span className="text-base text-gray-400 font-orbitron font-bold">
                          {r.roundNumber}
                        </span>
                      </div>

                      {/* Divider */}
                      <div className="w-px h-8 bg-gradient-to-b from-transparent via-gray-700 to-transparent" />

                      {/* Winning digit - larger and more prominent */}
                      <div className="flex flex-col items-center">
                        <span className="text-[10px] text-gray-600 font-rajdhani uppercase tracking-wider mb-1">Winner</span>
                        {r.winningDigit !== null ? (
                          <div
                            className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-lg font-orbitron"
                            style={{
                              background: `linear-gradient(135deg, ${DIGIT_COLORS[r.winningDigit]} 0%, ${DIGIT_COLORS[r.winningDigit]}cc 100%)`,
                              boxShadow: `0 0 20px ${DIGIT_COLORS[r.winningDigit]}66, inset 0 1px 0 rgba(255,255,255,0.3)`
                            }}
                          >
                            {r.winningDigit}
                          </div>
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center text-gray-500 font-bold text-lg font-orbitron border border-gray-700">?</div>
                        )}
                      </div>

                      {/* Spacer */}
                      <div className="flex-1" />

                      {/* Pool */}
                      <div className="text-right">
                        <span className="text-[10px] text-gray-600 font-rajdhani uppercase tracking-wider block">Prize Pool</span>
                        <span className="text-lg font-orbitron font-bold text-[#00ff88]" style={{ textShadow: '0 0 10px #00ff8844' }}>
                          {r.totalPool}
                        </span>
                        <span className="text-xs text-gray-500 font-rajdhani ml-1">{config.tokenSymbol}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* My Bets Modal */}
      {showMyBetsModal && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-end justify-center" onClick={() => setShowMyBetsModal(false)}>
          <div
            className="w-full max-w-2xl max-h-[70vh] bg-linear-to-br from-[#0a0a0f] via-[#12121a] to-[#0a0a0f] rounded-t-2xl flex flex-col animate-slide-up relative overflow-hidden"
            onClick={e => e.stopPropagation()}
            style={{
              boxShadow: '0 0 60px #00ff8822, inset 0 1px 0 #ffffff08'
            }}
          >
            {/* Glowing border */}
            <div
              className="absolute inset-0 rounded-t-2xl pointer-events-none"
              style={{ border: '1px solid #00ff8844', borderBottom: 'none' }}
            />

            {/* Grid background */}
            <div
              className="absolute inset-0 opacity-5 pointer-events-none"
              style={{
                backgroundImage: 'linear-gradient(#00ff8808 1px, transparent 1px), linear-gradient(90deg, #00ff8808 1px, transparent 1px)',
                backgroundSize: '30px 30px'
              }}
            />

            {/* Header */}
            <div className="relative px-5 py-4 flex items-center justify-between border-b border-[#00ff8822]">
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
                    boxShadow: '0 0 15px #00ff8844'
                  }}
                >
                  <Dices size={16} className="text-[#0a0a0f]" />
                </div>
                <div className="leading-tight">
                  <span className="text-lg font-bold text-white font-orbitron tracking-widest block">MY BETS</span>
                  <p className="text-xs text-gray-500 font-rajdhani tracking-wider -mt-0.5">@{userNametag.toUpperCase()}</p>
                </div>
              </div>
              <button
                onClick={() => setShowMyBetsModal(false)}
                className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content */}
            <div className="relative px-4 py-4 overflow-y-auto flex-1">
              {isMyBetsLoading ? (
                <div className="text-center py-8 text-gray-500 text-sm font-rajdhani">Loading...</div>
              ) : !userBetsHistory || userBetsHistory.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm font-rajdhani">No bets yet</div>
              ) : (
                <div className="space-y-2">
                  {userBetsHistory.map((bet, index) => {
                    const roundInfo = typeof bet.roundId === 'object' && bet.roundId !== null
                      ? { roundNumber: (bet.roundId as Round).roundNumber, winningDigit: (bet.roundId as Round).winningDigit }
                      : { roundNumber: bet.roundNumber, winningDigit: null };
                    const isWinner = bet.won === true;
                    const isLoser = bet.won === false;

                    // Refunded bets are not "open" - they're cancelled
                    const isRefunded = bet.paymentStatus === 'refunded';
                    const isPending = !isWinner && !isLoser && !isRefunded && bet.paymentStatus === 'paid';

                    return (
                      <div
                        key={bet._id}
                        className="flex items-center gap-3 px-4 py-3 rounded-xl relative group"
                        style={{
                          background: index === 0
                            ? isWinner ? 'linear-gradient(135deg, #00ff8815 0%, transparent 100%)' : isPending ? 'linear-gradient(135deg, #ffd70015 0%, transparent 100%)' : 'rgba(255,255,255,0.02)'
                            : 'rgba(255,255,255,0.02)',
                          border: index === 0
                            ? isWinner ? '1px solid #00ff8833' : isPending ? '1px solid #ffd70033' : '1px solid transparent'
                            : '1px solid transparent'
                        }}
                      >
                        {/* Result badge */}
                        <span className={`text-sm font-orbitron font-bold w-12 shrink-0 ${
                          isWinner ? 'text-green-400' : isPending ? 'text-yellow-400' : isRefunded ? 'text-blue-400' : 'text-gray-500'
                        }`}>
                          {isWinner ? 'WIN' : isPending ? 'OPEN' : isRefunded ? 'RFND' : 'LOSS'}
                        </span>

                        {/* Divider */}
                        <div className="w-px h-10 bg-gradient-to-b from-transparent via-gray-700 to-transparent" />

                        {/* Round number */}
                        <span className="text-base text-gray-500 font-rajdhani font-semibold w-10 shrink-0">
                          #{roundInfo.roundNumber}
                        </span>

                        {/* Divider */}
                        <div className="w-px h-10 bg-gradient-to-b from-transparent via-gray-700 to-transparent" />

                        {/* Bet digits */}
                        <div className="flex gap-1">
                          {bet.bets.map((b, i) => {
                            const isWinningDigit = roundInfo.winningDigit === b.digit;
                            return (
                              <div
                                key={i}
                                className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs font-orbitron"
                                style={{
                                  background: `linear-gradient(135deg, ${DIGIT_COLORS[b.digit]} 0%, ${DIGIT_COLORS[b.digit]}cc 100%)`,
                                  opacity: isWinner ? (isWinningDigit ? 1 : 0.3) : 0.85,
                                  boxShadow: isWinningDigit ? `0 0 12px ${DIGIT_COLORS[b.digit]}66, inset 0 1px 0 rgba(255,255,255,0.3)` : 'inset 0 1px 0 rgba(255,255,255,0.2)'
                                }}
                              >
                                {b.digit}
                              </div>
                            );
                          })}
                        </div>

                        {/* Spacer */}
                        <div className="flex-1 min-w-2" />

                        {/* Amount */}
                        <div className="text-right shrink-0">
                          {isWinner ? (
                            <span className="text-lg font-orbitron font-bold text-[#00ff88]" style={{ textShadow: '0 0 10px #00ff8844' }}>
                              +{bet.winnings}
                              <span className="text-xs text-gray-500 font-rajdhani ml-1">{config.tokenSymbol}</span>
                            </span>
                          ) : (
                            <span className="text-lg font-orbitron font-bold text-gray-400">
                              {bet.totalAmount}
                              <span className="text-xs text-gray-500 font-rajdhani ml-1">{config.tokenSymbol}</span>
                            </span>
                          )}
                        </div>

                        {/* Payment status - only show if not paid */}
                        {bet.paymentStatus !== 'paid' && (
                          <span className={`text-xs font-bold font-rajdhani shrink-0 ${
                            bet.paymentStatus === 'pending' ? 'text-yellow-400' :
                            bet.paymentStatus === 'refunded' ? 'text-blue-400' :
                            'text-red-400'
                          }`}>
                            {bet.paymentStatus.toUpperCase()}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* How To Play Modal */}
      {showHowToPlayModal && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-end justify-center" onClick={() => setShowHowToPlayModal(false)}>
          <div
            className="w-full max-w-2xl max-h-[85vh] bg-linear-to-br from-[#0a0a0f] via-[#12121a] to-[#0a0a0f] rounded-t-2xl flex flex-col animate-slide-up relative overflow-hidden"
            onClick={e => e.stopPropagation()}
            style={{
              boxShadow: '0 0 60px #00ff8822, inset 0 1px 0 #ffffff08'
            }}
          >
            {/* Glowing border */}
            <div
              className="absolute inset-0 rounded-t-2xl pointer-events-none"
              style={{ border: '1px solid #00ff8844', borderBottom: 'none' }}
            />

            {/* Grid background */}
            <div
              className="absolute inset-0 opacity-5 pointer-events-none"
              style={{
                backgroundImage: 'linear-gradient(#00ff8808 1px, transparent 1px), linear-gradient(90deg, #00ff8808 1px, transparent 1px)',
                backgroundSize: '30px 30px'
              }}
            />

            {/* Header */}
            <div className="relative px-5 py-4 flex items-center justify-between border-b border-[#00ff8822]">
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
                    boxShadow: '0 0 15px #00ff8844'
                  }}
                >
                  <Target size={16} className="text-[#0a0a0f]" />
                </div>
                <div className="leading-tight">
                  <span className="text-lg font-bold text-white font-orbitron tracking-widest block">HOW TO PLAY</span>
                  <p className="text-xs text-gray-500 font-rajdhani tracking-wider -mt-0.5">GAME GUIDE</p>
                </div>
              </div>
              <button
                onClick={() => setShowHowToPlayModal(false)}
                className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content */}
            <div className="relative px-5 py-6 overflow-y-auto flex-1">
              {/* Step 1 */}
              <div className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-[#00ff88] text-[#0a0a0f] flex items-center justify-center text-base font-bold font-orbitron">1</div>
                  <h3 className="text-base font-bold text-white font-rajdhani">Connect Your Wallet</h3>
                </div>
                <p className="text-sm text-gray-400 font-rajdhani ml-11">
                  Enter your Nostr nametag to connect. This links your identity to receive winnings automatically.
                </p>
              </div>

              {/* Step 2 */}
              <div className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-[#00ff88] text-[#0a0a0f] flex items-center justify-center text-base font-bold font-orbitron">2</div>
                  <h3 className="text-base font-bold text-white font-rajdhani">Place Your Bets</h3>
                </div>
                <p className="text-sm text-gray-400 font-rajdhani ml-11">
                  Choose any digit from 0-9 and enter your bet amount. You can bet on multiple digits in a single round.
                </p>
                <div className="ml-11 mt-2 flex gap-1.5">
                  {[0,1,2,3,4,5,6,7,8,9].map(d => (
                    <div key={d} className="w-7 h-7 rounded-full flex items-center justify-center text-white text-sm font-bold font-orbitron" style={{ background: DIGIT_COLORS[d] }}>{d}</div>
                  ))}
                </div>
              </div>

              {/* Step 3 */}
              <div className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-[#00ff88] text-[#0a0a0f] flex items-center justify-center text-base font-bold font-orbitron">3</div>
                  <h3 className="text-base font-bold text-white font-rajdhani">Confirm Payment</h3>
                </div>
                <p className="text-sm text-gray-400 font-rajdhani ml-11">
                  After placing your bet, a payment request will be sent to your wallet. Confirm the payment to lock in your bet.
                </p>
              </div>

              {/* Step 4 */}
              <div className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-[#00ff88] text-[#0a0a0f] flex items-center justify-center text-base font-bold font-orbitron">4</div>
                  <h3 className="text-base font-bold text-white font-rajdhani">Wait for the Draw</h3>
                </div>
                <p className="text-sm text-gray-400 font-rajdhani ml-11">
                  Each round has a countdown timer. When it reaches zero, a random winning digit is drawn.
                </p>
              </div>

              {/* Step 5 */}
              <div className="mb-8">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-[#00ff88] text-[#0a0a0f] flex items-center justify-center text-base font-bold font-orbitron">5</div>
                  <h3 className="text-base font-bold text-white font-rajdhani">Collect Winnings</h3>
                </div>
                <p className="text-sm text-gray-400 font-rajdhani ml-11">
                  If your digit wins, you share the pool with other winners! Winnings are sent automatically to your wallet.
                </p>
              </div>

              {/* Pari-mutuel explanation */}
              <div
                className="rounded-xl p-5 relative overflow-hidden"
                style={{
                  background: 'linear-gradient(135deg, #ffd70008 0%, transparent 100%)',
                  border: '1px solid #ffd70033'
                }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <Lightbulb size={18} className="text-[#ffd700]" />
                  <h4 className="text-base font-bold text-[#ffd700] font-orbitron tracking-wider">PARI-MUTUEL</h4>
                </div>
                <p className="text-sm text-gray-400 font-rajdhani leading-relaxed">
                  All bets go into a shared pool. Winners split the entire pool proportionally based on their bet amounts.
                  The more you bet on the winning digit, the larger your share of the pot!
                </p>
                <div className="mt-4 flex items-center gap-3 text-sm font-rajdhani flex-wrap">
                  <span className="text-[#ffd700] font-semibold">100 {config.tokenSymbol} pool</span>
                  <span className="text-gray-600">→</span>
                  <span className="text-white">Your bet: 10</span>
                  <span className="text-gray-600">→</span>
                  <span className="text-[#00ff88] font-semibold">Win your share!</span>
                </div>
              </div>
            </div>

            {/* Footer with button - always visible */}
            <div className="relative px-5 py-4 border-t border-[#00ff8822]">
              <button
                onClick={() => setShowHowToPlayModal(false)}
                className="w-full py-3.5 rounded-xl text-[#0a0a0f] text-sm font-bold font-orbitron tracking-widest"
                style={{
                  background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
                  boxShadow: '0 0 30px #00ff8844, 0 4px 15px #00ff8833'
                }}
              >
                START PLAYING
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment Confirmation Modal */}
      {showPaymentModal && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md flex items-center justify-center z-50">
          <div
            className="relative w-full max-w-sm mx-4 bg-linear-to-br from-[#0a0a0f] via-[#12121a] to-[#0a0a0f] rounded-2xl overflow-hidden"
            style={{
              boxShadow: '0 0 60px #00ff8822, 0 0 100px #00ff8811, inset 0 1px 0 #ffffff08'
            }}
          >
            {/* Glowing border */}
            <div
              className="absolute inset-0 rounded-2xl pointer-events-none"
              style={{
                border: '1px solid #00ff8844',
                boxShadow: 'inset 0 0 20px #00ff8811'
              }}
            />

            {/* Grid background */}
            <div
              className="absolute inset-0 opacity-10 pointer-events-none"
              style={{
                backgroundImage: 'linear-gradient(#00ff8808 1px, transparent 1px), linear-gradient(90deg, #00ff8808 1px, transparent 1px)',
                backgroundSize: '20px 20px'
              }}
            />

            {/* Content */}
            <div className="relative px-6 py-6">
              {paymentStep === 'confirm' ? (
                <>
                  {/* Header */}
                  <div className="text-center mb-6">
                    <div
                      className="w-14 h-14 mx-auto mb-3 rounded-xl flex items-center justify-center"
                      style={{
                        background: 'linear-gradient(135deg, #ffd700 0%, #ffaa00 100%)',
                        boxShadow: '0 0 30px #ffd70044'
                      }}
                    >
                      <Dices size={28} className="text-[#0a0a0f]" />
                    </div>
                    <h2 className="text-lg font-bold text-white font-orbitron tracking-widest">
                      CONFIRM BET
                    </h2>
                    <p className="text-xs text-gray-500 font-rajdhani mt-1">
                      Round #{round?.roundNumber}
                    </p>
                  </div>

                  {/* Bet Summary */}
                  <div className="mb-6">
                    <div className="flex justify-center gap-2 mb-4 flex-wrap">
                      {pendingBetItems.map((item, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-full"
                          style={{
                            background: `${DIGIT_COLORS[item.digit]}22`,
                            border: `1px solid ${DIGIT_COLORS[item.digit]}66`
                          }}
                        >
                          <div
                            className="w-6 h-6 rounded-full flex items-center justify-center text-white font-bold text-xs font-orbitron"
                            style={{ background: DIGIT_COLORS[item.digit] }}
                          >
                            {item.digit}
                          </div>
                          <span className="text-sm font-semibold font-rajdhani" style={{ color: DIGIT_COLORS[item.digit] }}>
                            {item.amount}
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* Total */}
                    <div
                      className="text-center py-3 rounded-xl"
                      style={{
                        background: 'linear-gradient(135deg, #ffd70011 0%, transparent 100%)',
                        border: '1px solid #ffd70033'
                      }}
                    >
                      <span className="text-gray-400 text-sm font-rajdhani">Total: </span>
                      <span className="text-2xl font-bold font-orbitron text-[#ffd700]" style={{ textShadow: '0 0 20px #ffd70044' }}>
                        {pendingBetItems.reduce((sum, item) => sum + item.amount, 0)}
                      </span>
                      <span className="text-sm text-gray-400 font-rajdhani ml-1">{config.tokenSymbol}</span>
                    </div>
                  </div>

                  {/* Buttons */}
                  <div className="flex gap-3">
                    <button
                      onClick={handleCancelBet}
                      className="flex-1 px-4 py-3 bg-transparent border-2 border-[#333] rounded-xl text-gray-400 text-sm font-orbitron font-semibold tracking-widest hover:border-[#444] hover:text-gray-300 transition-all"
                    >
                      CANCEL
                    </button>
                    <button
                      onClick={handleConfirmBet}
                      className="flex-1 px-4 py-3 rounded-xl text-[#0a0a0f] text-sm font-orbitron font-bold tracking-widest"
                      style={{
                        background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
                        boxShadow: '0 0 30px #00ff8844, 0 4px 15px #00ff8833'
                      }}
                    >
                      CONFIRM
                    </button>
                  </div>
                </>
              ) : paymentStep === 'awaiting' ? (
                <>
                  {/* Awaiting Payment State */}
                  <div className="text-center py-4">
                    <div className="w-16 h-16 mx-auto mb-4 relative">
                      {/* Spinning ring */}
                      <div
                        className="absolute inset-0 rounded-full border-4 border-transparent animate-spin"
                        style={{
                          borderTopColor: '#00ff88',
                          borderRightColor: '#00ff8866',
                          animationDuration: '1s'
                        }}
                      />
                      {/* Inner glow */}
                      <div
                        className="absolute inset-2 rounded-full flex items-center justify-center"
                        style={{
                          background: 'radial-gradient(circle, #00ff8822 0%, transparent 70%)'
                        }}
                      >
                        <div className="w-6 h-6 rounded-full bg-[#00ff88] animate-pulse" />
                      </div>
                    </div>

                    <h2 className="text-base font-bold text-[#00ff88] font-orbitron tracking-widest mb-2">
                      AWAITING PAYMENT
                    </h2>
                    <p className="text-sm text-gray-400 font-rajdhani mb-1">
                      Check your wallet for the payment request
                    </p>
                    <p className="text-xs text-gray-600 font-rajdhani">
                      Waiting for confirmation...
                    </p>

                    {/* Amount reminder */}
                    <div className="mt-4 pt-4 border-t border-white/5">
                      <span className="text-gray-500 text-sm font-rajdhani">Amount: </span>
                      <span className="text-lg font-bold font-orbitron text-[#ffd700]">
                        {pendingBetItems.reduce((sum, item) => sum + item.amount, 0)}
                      </span>
                      <span className="text-sm text-gray-400 font-rajdhani ml-1">{config.tokenSymbol}</span>
                    </div>
                  </div>
                </>
              ) : paymentStep === 'paid' ? (
                <>
                  {/* Payment Confirmed State */}
                  <div className="text-center py-4">
                    <div
                      className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center"
                      style={{
                        background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
                        boxShadow: '0 0 40px #00ff8866'
                      }}
                    >
                      <Check size={32} className="text-[#0a0a0f]" />
                    </div>

                    <h2 className="text-base font-bold text-[#00ff88] font-orbitron tracking-widest mb-2">
                      BET CONFIRMED!
                    </h2>
                    <p className="text-sm text-gray-400 font-rajdhani">
                      Your bet has been placed successfully
                    </p>

                    {/* Amount */}
                    <div className="mt-4 pt-4 border-t border-white/5">
                      <span className="text-gray-500 text-sm font-rajdhani">Bet Amount: </span>
                      <span className="text-lg font-bold font-orbitron text-[#00ff88]">
                        {pendingBetItems.reduce((sum, item) => sum + item.amount, 0)}
                      </span>
                      <span className="text-sm text-gray-400 font-rajdhani ml-1">{config.tokenSymbol}</span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Payment Failed State */}
                  <div className="text-center py-4">
                    <div
                      className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center"
                      style={{
                        background: 'linear-gradient(135deg, #ff6b6b 0%, #cc4444 100%)',
                        boxShadow: '0 0 40px #ff6b6b44'
                      }}
                    >
                      <X size={32} className="text-white" />
                    </div>

                    <h2 className="text-base font-bold text-[#ff6b6b] font-orbitron tracking-widest mb-2">
                      PAYMENT FAILED
                    </h2>
                    <p className="text-sm text-gray-400 font-rajdhani mb-4">
                      {paymentError || 'An error occurred. Please try again.'}
                    </p>

                    {/* Close button */}
                    <button
                      onClick={handleCancelBet}
                      className="px-8 py-3 bg-transparent border-2 border-[#333] rounded-xl text-gray-400 text-sm font-orbitron font-semibold tracking-widest hover:border-[#444] hover:text-gray-300 transition-all"
                    >
                      CLOSE
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
