import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { gameApi } from '../api/client';

export function History() {
  const { data, isLoading } = useQuery({
    queryKey: ['roundHistory'],
    queryFn: () => gameApi.getRoundHistory(20),
  });

  const rounds = data?.data.data || [];

  return (
    <div className="max-w-md mx-auto p-4">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-xl font-bold">History</h1>
        <Link to="/" className="text-sm text-purple-400">Back</Link>
      </div>

      {isLoading ? (
        <div className="text-center py-4">Loading...</div>
      ) : rounds.length === 0 ? (
        <div className="text-center py-4 text-gray-400">No rounds yet</div>
      ) : (
        <div className="space-y-2">
          {rounds.map((r) => (
            <div key={r._id} className="bg-white/10 rounded p-3 text-sm flex justify-between">
              <span>#{r.roundNumber}</span>
              <span className="text-yellow-400 font-bold">{r.winningDigit}</span>
              <span>Pool: {r.totalPool}</span>
              <span className="text-green-400">Paid: {r.totalPayout}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
