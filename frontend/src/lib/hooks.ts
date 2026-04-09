/**
 * React Query hooks for all API endpoints.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";

// ─── Types ────────────────────────────────────────────────────────────────────

export type KpiRow = {
  user_amo_id: number;
  revenue_won: number;
  deals_won: number;
  deals_lost: number;
  win_rate: number;
  calls_made: number;
  tasks_completed: number;
  notes_added: number;
  response_time_p50: number;
  deal_velocity_avg: number;
  avg_deal_value: number;
  revenue_delta_pct: number | null;
  win_rate_delta: number | null;
  deals_won_delta: number | null;
};

export type OverviewData = {
  period: string;
  summary: {
    total_revenue: number;
    total_deals_won: number;
    total_deals_created: number;
    avg_win_rate: number;
    total_calls_made: number;
    active_managers: number;
  } | null;
  topManagers: { user_amo_id: number; revenue_won: number; win_rate: number }[];
  alertCount: number;
  criticalAlerts: number;
};

export type ManagerProfile = {
  userAmoId: number;
  period: string;
  timeSeries: {
    date: string;
    revenue_won: number;
    deals_won: number;
    win_rate: number;
    calls_made: number;
    response_time_p50: number;
  }[];
  profile: {
    percentile_revenue: number;
    percentile_win_rate: number;
    percentile_response: number;
    percentile_calls: number;
    profile: { strengths: string[]; weaknesses: string[]; trend: string };
  } | null;
  stuckDeals: StuckDeal[];
};

export type StuckDeal = {
  amo_id: number;
  name: string;
  price: number;
  responsible_user_amo_id: number;
  days_inactive: number;
  pipeline_amo_id: number;
  stage_amo_id: number;
};

export type Alert = {
  id: string;
  alertType: string;
  entityType: string;
  entityAmoId: number;
  severity: "warning" | "critical";
  data: Record<string, unknown>;
  createdAt: string;
};

// ─── Types cont. ─────────────────────────────────────────────────────────────

export type AmoUser = {
  amoId: number;
  name: string;
  email: string | null;
  planTarget: number | null;
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () =>
      api.get<{
        user: { id: string; email: string; name: string; role: string };
        accounts: { accountId: string; role: string; accountName: string; subdomain: string; syncStatus: string }[];
      }>("/auth/me"),
    retry: false,
  });
}

// ─── Active account selection ────────────────────────────────────────────────

/**
 * Возвращает активный accountId и функцию для его смены.
 * Выбор сохраняется в localStorage. По умолчанию — первый аккаунт пользователя.
 */
export function useActiveAccount(): {
  accountId: string;
  setAccountId: (id: string) => void;
} {
  const { data: me } = useMe();
  const accounts = me?.accounts ?? [];

  // Читаем из localStorage на клиенте
  const [accountId, setAccountIdState] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("activeAccountId") ?? "";
  });

  // Синхронизируем: если сохранённый аккаунт недоступен — сбрасываем на первый
  const validId = accounts.find((a) => a.accountId === accountId)?.accountId
    ?? accounts[0]?.accountId
    ?? "";

  function setAccountId(id: string) {
    localStorage.setItem("activeAccountId", id);
    setAccountIdState(id);
  }

  return { accountId: validId, setAccountId };
}

// ─── Account users ────────────────────────────────────────────────────────────

export function useAccountUsers(accountId: string) {
  return useQuery({
    queryKey: ["account-users", accountId],
    queryFn: () =>
      api.get<{ users: AmoUser[] }>(`/accounts/${accountId}/users`),
    enabled: Boolean(accountId),
    staleTime: 5 * 60_000, // user list changes rarely
  });
}

export type Pipeline = {
  amoId: number;
  name: string;
  isMain: boolean;
  stages: { amoId: number; name: string; type: number }[];
};

export function usePipelines(accountId: string) {
  return useQuery({
    queryKey: ["pipelines", accountId],
    queryFn: () =>
      api.get<{ pipelines: Pipeline[] }>(`/accounts/${accountId}/pipelines`),
    enabled: Boolean(accountId),
    staleTime: 5 * 60_000,
  });
}

/** Returns a Map<amoId, name> for quick lookups in tables/charts */
export function useManagerNames(accountId: string): Map<number, string> {
  const { data } = useAccountUsers(accountId);
  const map = new Map<number, string>();
  for (const u of data?.users ?? []) {
    map.set(u.amoId, u.name);
  }
  return map;
}

// ─── Overview ─────────────────────────────────────────────────────────────────

export function useOverview(accountId: string, period = "30d") {
  return useQuery({
    queryKey: ["overview", accountId, period],
    queryFn: () =>
      api.get<OverviewData>(`/analytics/${accountId}/overview?period=${period}`),
    refetchInterval: 60_000,
  });
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────

export function useKpis(accountId: string, period = "30d", managerId?: number) {
  const params = new URLSearchParams({ period });
  if (managerId) params.set("managerId", String(managerId));
  return useQuery({
    queryKey: ["kpis", accountId, period, managerId],
    queryFn: () =>
      api.get<{ data: KpiRow[] }>(`/analytics/${accountId}/kpis?${params}`),
    refetchInterval: 60_000,
  });
}

// ─── Manager list ─────────────────────────────────────────────────────────────

export function useManagers(accountId: string, period = "30d") {
  return useQuery({
    queryKey: ["managers", accountId, period],
    queryFn: () =>
      api.get<{ managers: (KpiRow & { profile: Record<string, unknown> })[] }>(
        `/analytics/${accountId}/managers?period=${period}`
      ),
    refetchInterval: 60_000,
  });
}

// ─── Manager profile ──────────────────────────────────────────────────────────

export function useManagerProfile(accountId: string, userId: number, period = "30d") {
  return useQuery({
    queryKey: ["manager", accountId, userId, period],
    queryFn: () =>
      api.get<ManagerProfile>(
        `/analytics/${accountId}/managers/${userId}?period=${period}`
      ),
  });
}

// ─── Sparklines ──────────────────────────────────────────────────────────────

export type SparklineData = {
  date: string;
  total_revenue: number;
  total_deals_won: number;
  total_calls_made: number;
  avg_win_rate: number;
};

export function useSparklines(accountId: string, days = 14) {
  return useQuery({
    queryKey: ["sparklines", accountId, days],
    queryFn: () =>
      api.get<{ data: SparklineData[] }>(`/analytics/${accountId}/sparklines?days=${days}`),
    enabled: Boolean(accountId),
    staleTime: 5 * 60_000,
  });
}

// ─── Heatmap ─────────────────────────────────────────────────────────────────

export function useHeatmap(accountId: string, pipelineId: number, period = "30d") {
  return useQuery({
    queryKey: ["heatmap", accountId, pipelineId, period],
    queryFn: () =>
      api.get<{
        rows: { user_amo_id: number; stage_amo_id: number; avg_hours: number; deal_count: number }[];
        managers: number[];
        stages: number[];
      }>(`/analytics/${accountId}/heatmap?pipelineId=${pipelineId}&period=${period}`),
    enabled: Boolean(accountId && pipelineId),
  });
}

// ─── Funnel ───────────────────────────────────────────────────────────────────

export function useFunnel(accountId: string, pipelineId: number, period = "30d") {
  return useQuery({
    queryKey: ["funnel", accountId, pipelineId, period],
    queryFn: () =>
      api.get<{
        transitions: { from_stage_amo_id: number; to_stage_amo_id: number; transition_count: number; avg_time_hours: number }[];
        stageTimes: { stage_amo_id: number; avg_hours: number; p50_hours: number; p90_hours: number }[];
      }>(`/analytics/${accountId}/funnel?pipelineId=${pipelineId}&period=${period}`),
  });
}

// ─── Stuck deals ──────────────────────────────────────────────────────────────

export function useStuckDeals(accountId: string, managerId?: number) {
  const params = managerId ? `?managerId=${managerId}` : "";
  return useQuery({
    queryKey: ["stuck-deals", accountId, managerId],
    queryFn: () =>
      api.get<{ deals: StuckDeal[] }>(`/analytics/${accountId}/deals/stuck${params}`),
  });
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

export function useAlerts(accountId: string) {
  return useQuery({
    queryKey: ["alerts", accountId],
    queryFn: () =>
      api.get<{ alerts: Alert[] }>(`/analytics/${accountId}/bottlenecks`),
    refetchInterval: 120_000,
  });
}
