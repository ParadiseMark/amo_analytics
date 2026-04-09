"use client";
import { useState } from "react";
import { useOverview, useKpis, useAlerts, useManagerNames, useSparklines } from "@/lib/hooks";
import { useAccountId } from "@/lib/account-context";
import { KpiCard } from "@/components/ui/KpiCard";
import { AlertBadge } from "@/components/ui/AlertBadge";
import { formatCurrency, formatPct } from "@/lib/utils";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

const PERIODS = [
  { value: "7d",  label: "7 дней" },
  { value: "30d", label: "30 дней" },
  { value: "90d", label: "90 дней" },
];

export default function OverviewPage() {
  const accountId = useAccountId();

  const [period, setPeriod] = usePeriod("30d");
  const { data: overview, isLoading } = useOverview(accountId, period);
  const { data: kpisData } = useKpis(accountId, period);
  const { data: alertsData } = useAlerts(accountId);
  const { data: sparklinesData } = useSparklines(accountId);
  const managerNames = useManagerNames(accountId);

  const summary = overview?.summary;
  const topManagers = overview?.topManagers ?? [];
  const criticalAlerts = alertsData?.alerts.filter((a) => a.severity === "critical") ?? [];
  const kpis = kpisData?.data ?? [];
  const sparklines = sparklinesData?.data ?? [];
  const revenueSparkline = sparklines.map((s) => s.total_revenue);
  const dealsSparkline = sparklines.map((s) => s.total_deals_won);
  const callsSparkline = sparklines.map((s) => s.total_calls_made);
  const winRateSparkline = sparklines.map((s) => s.avg_win_rate * 100);

  if (!accountId) return null;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Обзор команды</h1>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {/* Critical alerts banner */}
      {criticalAlerts.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-800">
              {criticalAlerts.length} критических алертов
            </p>
            <p className="text-xs text-red-600 mt-0.5">
              Обнаружены узкие места, требующие внимания
            </p>
          </div>
          <Link
            href="/dashboard/stuck"
            className="ml-auto text-xs font-medium text-red-700 underline"
          >
            Подробнее →
          </Link>
        </div>
      )}

      {/* KPI cards */}
      {isLoading || !summary ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 h-24 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <KpiCard
            label="Выручка"
            value={formatCurrency(summary.total_revenue)}
            sparkline={revenueSparkline}
            sparklineColor="#3b82f6"
          />
          <KpiCard
            label="Сделок закрыто"
            value={summary.total_deals_won}
            sparkline={dealsSparkline}
            sparklineColor="#10b981"
          />
          <KpiCard
            label="Сделок создано"
            value={summary.total_deals_created}
          />
          <KpiCard
            label="Win Rate"
            value={formatPct(summary.avg_win_rate * 100, 1)}
            sparkline={winRateSparkline}
            sparklineColor="#8b5cf6"
          />
          <KpiCard
            label="Звонков"
            value={summary.total_calls_made}
            sparkline={callsSparkline}
            sparklineColor="#f59e0b"
          />
          <KpiCard
            label="Менеджеров"
            value={summary.active_managers}
            subtitle="активных"
          />
        </div>
      )}

      {/* Leaderboard + alerts side-by-side */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Top managers */}
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Топ менеджеров — выручка</h2>
            <Link href="/dashboard/managers" className="text-xs text-brand-600 font-medium">
              Все →
            </Link>
          </div>
          <div className="divide-y divide-gray-50">
            {kpis.slice(0, 8).map((m, i) => (
              <Link
                key={m.user_amo_id}
                href={`/dashboard/managers/${m.user_amo_id}`}
                className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors"
              >
                <span className="w-6 text-sm font-bold text-gray-400">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">
                    {managerNames.get(m.user_amo_id) ?? `Manager #${m.user_amo_id}`}
                  </p>
                  <p className="text-xs text-gray-500">
                    {m.deals_won} сделок · win {formatPct(m.win_rate * 100, 0)}
                  </p>
                </div>
                <span className="text-sm font-semibold text-gray-900">
                  {formatCurrency(m.revenue_won)}
                </span>
                {m.revenue_delta_pct != null && (
                  <span
                    className={`text-xs font-medium ${
                      m.revenue_delta_pct >= 0 ? "text-green-600" : "text-red-500"
                    }`}
                  >
                    {m.revenue_delta_pct >= 0 ? "+" : ""}
                    {m.revenue_delta_pct.toFixed(0)}%
                  </span>
                )}
              </Link>
            ))}
            {kpis.length === 0 && (
              <p className="px-5 py-8 text-sm text-gray-400 text-center">Нет данных</p>
            )}
          </div>
        </div>

        {/* Active alerts */}
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">
              Активные алерты{" "}
              {alertsData && (
                <span className="text-gray-400 font-normal">
                  ({alertsData.alerts.length})
                </span>
              )}
            </h2>
          </div>
          <div className="divide-y divide-gray-50">
            {(alertsData?.alerts ?? []).slice(0, 8).map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-5 py-3">
                <AlertBadge severity={a.severity} label={a.severity === "critical" ? "Критично" : "Внимание"} />
                <div className="min-w-0">
                  <p className="text-sm text-gray-800">
                    {a.alertType === "stage_bottleneck" && "Узкий этап воронки"}
                    {a.alertType === "low_win_rate" && "Низкий win rate"}
                    {a.alertType === "stuck_deal" && "Зависшая сделка"}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {a.entityType} #{a.entityAmoId}
                  </p>
                </div>
              </div>
            ))}
            {(!alertsData || alertsData.alerts.length === 0) && (
              <p className="px-5 py-8 text-sm text-gray-400 text-center">Алертов нет ✓</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function usePeriod(initial: string): [string, (v: string) => void] {
  const [period, setPeriod] = useState(initial);
  return [period, setPeriod];
}

function PeriodSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
      {PERIODS.map((p) => (
        <button
          key={p.value}
          onClick={() => onChange(p.value)}
          className={`px-3 py-1.5 font-medium transition-colors ${
            value === p.value
              ? "bg-brand-600 text-white"
              : "bg-white text-gray-600 hover:bg-gray-50"
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
