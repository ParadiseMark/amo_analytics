"use client";
import { useState } from "react";
import { use } from "react";
import { useManagerProfile, useManagerNames } from "@/lib/hooks";
import { useAccountId } from "@/lib/account-context";
import { KpiCard } from "@/components/ui/KpiCard";
import { formatCurrency, formatPct, formatMinutes } from "@/lib/utils";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { ArrowLeft, TrendingUp, TrendingDown, Minus } from "lucide-react";
import Link from "next/link";

const TREND_ICONS = {
  improving: <TrendingUp className="w-4 h-4 text-green-500" />,
  declining:  <TrendingDown className="w-4 h-4 text-red-500" />,
  stable:     <Minus className="w-4 h-4 text-gray-400" />,
};

const STRENGTH_LABELS: Record<string, string> = {
  high_revenue:        "Высокая выручка",
  high_win_rate:       "Высокий win rate",
  fast_response_time:  "Быстрый ответ",
  high_call_rate:      "Активные звонки",
  improving_trend:     "Растущий тренд",
};
const WEAKNESS_LABELS: Record<string, string> = {
  low_revenue:         "Низкая выручка",
  low_win_rate:        "Низкий win rate",
  slow_response_time:  "Медленный ответ",
  low_call_rate:       "Мало звонков",
  declining_trend:     "Падающий тренд",
};

const PERIODS = [
  { value: "7d",  label: "7 дн" },
  { value: "30d", label: "30 дн" },
  { value: "90d", label: "90 дн" },
];

export default function ManagerProfilePage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  const accountId = useAccountId();
  const [period, setPeriod] = useState("30d");

  const { data, isLoading } = useManagerProfile(accountId, Number(userId), period);
  const managerNames = useManagerNames(accountId);
  const managerName = managerNames.get(Number(userId)) ?? `Manager #${userId}`;

  const profile = data?.profile;
  const timeSeries = data?.timeSeries ?? [];
  const stuckDeals = data?.stuckDeals ?? [];

  // Aggregate KPIs from time series
  const totalRevenue = timeSeries.reduce((s, r) => s + r.revenue_won, 0);
  const totalDealsWon = timeSeries.reduce((s, r) => s + r.deals_won, 0);
  const avgWinRate = timeSeries.length
    ? timeSeries.reduce((s, r) => s + r.win_rate, 0) / timeSeries.length
    : 0;
  const totalCalls = timeSeries.reduce((s, r) => s + r.calls_made, 0);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link
          href="/dashboard/managers"
          className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-gray-500" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900">{managerName}</h1>
          {profile && (
            <div className="flex items-center gap-2 mt-1">
              {TREND_ICONS[profile.profile.trend as keyof typeof TREND_ICONS]}
              <span className="text-sm text-gray-500">
                {profile.profile.trend === "improving"
                  ? "Растущий тренд"
                  : profile.profile.trend === "declining"
                  ? "Снижение"
                  : "Стабильно"}
              </span>
            </div>
          )}
        </div>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-3 py-1.5 font-medium transition-colors ${
                period === p.value
                  ? "bg-brand-600 text-white"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Выручка" value={formatCurrency(totalRevenue)} />
        <KpiCard label="Сделок закрыто" value={totalDealsWon} />
        <KpiCard label="Win Rate" value={formatPct(avgWinRate * 100, 1)} />
        <KpiCard label="Звонков" value={totalCalls} />
      </div>

      {/* Revenue trend chart */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900 mb-4">Динамика выручки</h2>
        {timeSeries.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={timeSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "#9ca3af" }}
                tickFormatter={(d: string) => d.slice(5)}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#9ca3af" }}
                tickFormatter={(v: number) => formatCurrency(v)}
                width={80}
              />
              <Tooltip
                formatter={(v: number) => [formatCurrency(v), "Выручка"]}
                labelStyle={{ fontSize: 12 }}
              />
              <Line
                type="monotone"
                dataKey="revenue_won"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-48 flex items-center justify-center text-gray-400 text-sm">
            Нет данных
          </div>
        )}
      </div>

      {/* Profile strengths / weaknesses + percentiles */}
      {profile && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Strengths & Weaknesses */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold text-gray-900">Профиль</h2>

            {profile.profile.strengths.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Сильные стороны</p>
                <div className="flex flex-wrap gap-2">
                  {profile.profile.strengths.map((s) => (
                    <span key={s} className="text-xs bg-green-50 text-green-700 px-2.5 py-1 rounded-full font-medium">
                      ✓ {STRENGTH_LABELS[s] ?? s}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {profile.profile.weaknesses.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Зоны роста</p>
                <div className="flex flex-wrap gap-2">
                  {profile.profile.weaknesses.map((w) => (
                    <span key={w} className="text-xs bg-red-50 text-red-600 px-2.5 py-1 rounded-full font-medium">
                      ↑ {WEAKNESS_LABELS[w] ?? w}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Percentiles */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="font-semibold text-gray-900 mb-4">Позиция в команде</h2>
            <div className="space-y-3">
              <PercentileBar label="Выручка" value={profile.percentile_revenue} />
              <PercentileBar label="Win Rate" value={profile.percentile_win_rate} />
              <PercentileBar label="Скорость ответа" value={profile.percentile_response} />
              <PercentileBar label="Звонки" value={profile.percentile_calls} />
            </div>
          </div>
        </div>
      )}

      {/* Stuck deals */}
      {stuckDeals.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">
              Зависшие сделки{" "}
              <span className="text-gray-400 font-normal">({stuckDeals.length})</span>
            </h2>
          </div>
          <div className="divide-y divide-gray-50">
            {stuckDeals.map((d) => (
              <div key={d.amo_id} className="flex items-center gap-3 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{d.name}</p>
                  <p className="text-xs text-gray-500">
                    {formatCurrency(d.price)} · Этап #{d.stage_amo_id}
                  </p>
                </div>
                <span className="text-xs font-medium text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">
                  {Math.round(d.days_inactive)} дн без активности
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PercentileBar({ label, value }: { label: string; value: number }) {
  const color =
    value >= 75 ? "bg-green-500" : value >= 40 ? "bg-brand-500" : "bg-red-400";
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-600">{label}</span>
        <span className="text-xs font-semibold text-gray-800">{Math.round(value)}‑й перцентиль</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
