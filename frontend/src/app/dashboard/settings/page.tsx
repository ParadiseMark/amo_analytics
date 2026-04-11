"use client";
import { useState, useEffect } from "react";
import { useMe } from "@/lib/hooks";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAccountId } from "@/lib/account-context";
import { api } from "@/lib/api";
import { Save, RefreshCw, AlertTriangle } from "lucide-react";

type AccountSettings = {
  id: string;
  subdomain: string;
  name: string | null;
  settings: {
    timezone?: string;
    currency?: string;
    planTargets?: Record<string, number>;
    stuckDaysThreshold?: number;
    bottleneckMultiplier?: number;
  };
  syncStatus: string;
  needsReauth: boolean;
  tokenDaysLeft: number;
};

type User = {
  amoId: number;
  name: string;
  email: string | null;
  planTarget: number | null;
};

export default function SettingsPage() {
  const { data: me } = useMe();
  const accountId = useAccountId();
  const qc = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ["account-settings", accountId],
    queryFn: () => api.get<AccountSettings>(`/accounts/${accountId}/settings`),
    enabled: Boolean(accountId),
  });

  const { data: usersData } = useQuery({
    queryKey: ["account-users", accountId],
    queryFn: () => api.get<{ users: User[] }>(`/accounts/${accountId}/users`),
    enabled: Boolean(accountId),
  });

  const isAdmin = me?.accounts.find((a) => a.accountId === accountId)?.role === "admin";

  // Form state
  const [timezone, setTimezone] = useState("");
  const [stuckDays, setStuckDays] = useState("");
  const [multiplier, setMultiplier] = useState("");
  const [planTargets, setPlanTargets] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setTimezone(settings.settings.timezone ?? "UTC");
    setStuckDays(String(settings.settings.stuckDaysThreshold ?? ""));
    setMultiplier(String(settings.settings.bottleneckMultiplier ?? ""));
    const targets: Record<string, string> = {};
    for (const [id, val] of Object.entries(settings.settings.planTargets ?? {})) {
      targets[id] = String(val);
    }
    setPlanTargets(targets);
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (body: unknown) =>
      api.post(`/accounts/${accountId}/settings`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-settings", accountId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => api.post(`/accounts/${accountId}/sync/trigger`),
  });

  function handleSave() {
    const targets: Record<string, number> = {};
    for (const [id, val] of Object.entries(planTargets)) {
      const n = Number(val);
      if (!isNaN(n) && n > 0) targets[id] = n;
    }

    saveMutation.mutate({
      timezone: timezone || undefined,
      stuckDaysThreshold: stuckDays ? Number(stuckDays) : undefined,
      bottleneckMultiplier: multiplier ? Number(multiplier) : undefined,
      planTargets: Object.keys(targets).length > 0 ? targets : undefined,
    });
  }

  if (isLoading || !settings) {
    return (
      <div className="p-6 space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 bg-white rounded-xl border border-gray-200 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <h1 className="text-xl font-bold text-gray-900">Настройки</h1>

      {/* Token warning — only shown when auto-refresh failed */}
      {settings.needsReauth && (
        <div className="flex items-start gap-3 p-4 rounded-xl border bg-red-50 border-red-200">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5 text-red-500" />
          <div>
            <p className="text-sm font-semibold text-gray-800">
              Токен AmoCRM истёк — требуется повторная авторизация
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              Переподключите аккаунт через{" "}
              <a href="/api/v1/oauth/start" className="underline">
                OAuth
              </a>
            </p>
          </div>
        </div>
      )}

      {/* Account info */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <h2 className="font-semibold text-gray-900">Аккаунт AmoCRM</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <Info label="Субдомен" value={settings.subdomain} />
          <Info label="Название" value={settings.name ?? "—"} />
          <Info label="Статус синхронизации" value={settings.syncStatus} />
        </div>
        {isAdmin && (
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="flex items-center gap-2 text-sm text-brand-600 hover:text-brand-700 font-medium mt-1"
          >
            <RefreshCw className={`w-4 h-4 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            {syncMutation.isPending ? "Запускается..." : "Запустить полную синхронизацию"}
          </button>
        )}
      </div>

      {/* General settings */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h2 className="font-semibold text-gray-900">Общие</h2>
        <Field label="Часовой пояс" hint="Например: Europe/Moscow">
          <input
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={!isAdmin}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50 disabled:text-gray-500"
          />
        </Field>
        <Field
          label="Порог зависших сделок (дней)"
          hint="Сделка считается зависшей после N дней без активности. По умолчанию: 2× средняя скорость."
        >
          <input
            type="number"
            min={1}
            max={365}
            value={stuckDays}
            onChange={(e) => setStuckDays(e.target.value)}
            disabled={!isAdmin}
            placeholder="Авто"
            className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
          />
        </Field>
        <Field
          label="Мультипликатор узкого этапа"
          hint="Этап считается узким местом, если среднее время > N× среднего по воронке. По умолчанию: 1.5"
        >
          <input
            type="number"
            min={1}
            max={10}
            step={0.1}
            value={multiplier}
            onChange={(e) => setMultiplier(e.target.value)}
            disabled={!isAdmin}
            placeholder="1.5"
            className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
          />
        </Field>
      </div>

      {/* Plan targets */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h2 className="font-semibold text-gray-900">Плановые показатели (выручка/мес)</h2>
        {(usersData?.users ?? []).length === 0 ? (
          <p className="text-sm text-gray-400">Нет активных менеджеров</p>
        ) : (
          <div className="space-y-3">
            {(usersData?.users ?? []).map((u) => (
              <div key={u.amoId} className="flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{u.name}</p>
                  <p className="text-xs text-gray-400">{u.email ?? `#${u.amoId}`}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    value={planTargets[String(u.amoId)] ?? ""}
                    onChange={(e) =>
                      setPlanTargets((prev) => ({
                        ...prev,
                        [String(u.amoId)]: e.target.value,
                      }))
                    }
                    disabled={!isAdmin}
                    placeholder="0"
                    className="w-32 px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-right disabled:bg-gray-50"
                  />
                  <span className="text-xs text-gray-400">₽</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Save button */}
      {isAdmin && (
        <button
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-medium text-sm rounded-xl transition-colors"
        >
          <Save className="w-4 h-4" />
          {saved ? "Сохранено ✓" : saveMutation.isPending ? "Сохранение..." : "Сохранить"}
        </button>
      )}

      {!isAdmin && (
        <p className="text-xs text-gray-400">
          Изменение настроек доступно только администраторам аккаунта.
        </p>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-sm font-medium text-gray-800">{value}</p>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
