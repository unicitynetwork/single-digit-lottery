import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { gameApi, type BetItem } from './client';
import { config } from '../config';

// Query keys
export const queryKeys = {
  currentRound: ['currentRound'] as const,
  previousRound: ['previousRound'] as const,
  roundHistory: (limit?: number) => ['roundHistory', limit] as const,
  userBets: (nametag: string, limit?: number) => ['userBets', nametag, limit] as const,
  userBetsInCurrentRound: (nametag: string) => ['userBetsInCurrentRound', nametag] as const,
  roundBets: (roundId: string) => ['roundBets', roundId] as const,
};

// Current round hook
export function useCurrentRound() {
  return useQuery({
    queryKey: queryKeys.currentRound,
    queryFn: async () => {
      const response = await gameApi.getCurrentRound();
      return response.data.data;
    },
    refetchInterval: config.refetchCurrentRound,
  });
}

// Previous round hook
export function usePreviousRound() {
  return useQuery({
    queryKey: queryKeys.previousRound,
    queryFn: async () => {
      const response = await gameApi.getPreviousRound();
      return response.data.data;
    },
    refetchInterval: config.refetchPreviousRound,
  });
}

// Round history hook
export function useRoundHistory(limit = 20) {
  return useQuery({
    queryKey: queryKeys.roundHistory(limit),
    queryFn: async () => {
      const response = await gameApi.getRoundHistory(limit);
      return response.data.data;
    },
    refetchInterval: config.refetchHistory,
  });
}

// User bets hook
export function useUserBets(nametag: string | undefined, limit = 50) {
  return useQuery({
    queryKey: queryKeys.userBets(nametag ?? '', limit),
    queryFn: async () => {
      const response = await gameApi.getUserBets(nametag!, limit);
      return response.data.data;
    },
    enabled: !!nametag,
  });
}

// Round bets hook
export function useRoundBets(roundId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.roundBets(roundId ?? ''),
    queryFn: async () => {
      const response = await gameApi.getRoundBets(roundId!);
      return response.data.data;
    },
    enabled: !!roundId,
  });
}

// User bets in current round hook
export function useUserBetsInCurrentRound(nametag: string | undefined) {
  return useQuery({
    queryKey: queryKeys.userBetsInCurrentRound(nametag ?? ''),
    queryFn: async () => {
      const response = await gameApi.getUserBetsInCurrentRound(nametag!);
      return response.data.data;
    },
    enabled: !!nametag,
    refetchInterval: config.refetchCurrentRound,
  });
}

// Validate nametag hook
export function useValidateNametag() {
  return useMutation({
    mutationFn: async (nametag: string) => {
      const response = await gameApi.validateNametag(nametag);
      return response.data.data;
    },
  });
}

// Place bets mutation hook
export function usePlaceBets() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userNametag, bets }: { userNametag: string; bets: BetItem[] }) => {
      const response = await gameApi.placeBets(userNametag, bets);
      return response.data.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.currentRound });
      queryClient.invalidateQueries({
        queryKey: queryKeys.userBetsInCurrentRound(variables.userNametag),
      });
    },
  });
}

// Invalidate all queries (useful after round ends)
export function useInvalidateRoundData() {
  const queryClient = useQueryClient();

  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.currentRound });
    queryClient.invalidateQueries({ queryKey: queryKeys.previousRound });
    queryClient.invalidateQueries({ queryKey: queryKeys.roundHistory() });
  };
}
