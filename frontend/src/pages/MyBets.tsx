import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { gameApi } from '../api/client';

export function MyBets() {
  const { nametag } = useParams<{ nametag: string }>();

  const { data, isLoading } = useQuery({
    queryKey: ['userBets', nametag],
    queryFn: () => gameApi.getUserBets(nametag!, 50),
    enabled: !!nametag,
  });

  const bets = data?.data.data || [];

  return (
    <div className="max-w-md mx-auto p-4">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-xl font-bold">My Bets</h1>
          <span className="text-sm text-gray-400">@{nametag}</span>
        </div>
        <Link to="/" className="text-sm text-purple-400">Back</Link>
      </div>

      {isLoading ? (
        <div className="text-center py-4">Loading...</div>
      ) : bets.length === 0 ? (
        <div className="text-center py-4 text-gray-400">No bets</div>
      ) : (
        <div className="space-y-2">
          {bets.map((bet) => (
            <div key={bet._id} className="bg-white/10 rounded p-3 text-sm">
              <div className="flex justify-between mb-2">
                <span className="text-gray-400">
                  {bet.paymentStatus === 'paid' ? '✓' : '○'} {bet.totalAmount} UCT
                </span>
                {bet.winnings > 0 && (
                  <span className="text-green-400">+{bet.winnings}</span>
                )}
              </div>
              <div className="flex gap-1">
                {bet.bets.map((b, i) => (
                  <span key={i} className="bg-purple-600/50 px-2 py-0.5 rounded text-xs">
                    {b.digit}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
