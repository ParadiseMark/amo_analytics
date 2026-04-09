"use client";
import { Suspense } from "react";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMe } from "@/lib/hooks";
import { useQueryClient } from "@tanstack/react-query";
import Cookies from "js-cookie";
import { CheckCircle, AlertCircle, Loader2, ExternalLink } from "lucide-react";

function ConnectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: me, refetch } = useMe();
  const qc = useQueryClient();

  const success = searchParams.get("success") === "1";
  const subdomain = searchParams.get("subdomain");
  const errorMsg = searchParams.get("error");

  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (success) {
      qc.invalidateQueries({ queryKey: ["me"] });
      refetch().then(() => {
        setTimeout(() => router.push("/dashboard"), 2000);
      });
    }
  }, [success, qc, refetch, router]);

  function handleConnect() {
    setConnecting(true);
    const token = Cookies.get("access_token");
    window.location.href = `/api/v1/oauth/start${token ? `?token=${token}` : ""}`;
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-10 w-full max-w-md text-center">
          <div className="flex justify-center mb-4">
            <CheckCircle className="w-14 h-14 text-green-500" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">AmoCRM подключён!</h1>
          {subdomain && (
            <p className="text-sm text-gray-500 mb-1">
              Аккаунт: <span className="font-medium text-gray-800">{subdomain}.amocrm.ru</span>
            </p>
          )}
          <p className="text-sm text-gray-400 mb-6">Начальная синхронизация запущена...</p>
          <div className="flex items-center justify-center gap-2 text-sm text-brand-600">
            <Loader2 className="w-4 h-4 animate-spin" />
            Переход в дашборд
          </div>
        </div>
      </div>
    );
  }

  if (errorMsg) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-10 w-full max-w-md text-center">
          <div className="flex justify-center mb-4">
            <AlertCircle className="w-14 h-14 text-red-400" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Ошибка подключения</h1>
          <p className="text-sm text-red-600 bg-red-50 px-4 py-2 rounded-lg mb-6">{decodeURIComponent(errorMsg)}</p>
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-medium py-2.5 px-4 rounded-xl text-sm transition-colors"
          >
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  const hasAccount = (me?.accounts?.length ?? 0) > 0;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-10 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">AMO Analytics</h1>
          <p className="text-sm text-gray-500 mt-1">
            {hasAccount ? "Подключить ещё один аккаунт" : "Подключите ваш AmoCRM"}
          </p>
        </div>
        <div className="space-y-3 mb-8">
          {[
            "Аналитика по каждому менеджеру: KPI, воронка, тренды",
            "Зависшие сделки и узкие места — автоматически",
            "AI-ассистент отвечает на вопросы по вашим данным",
            "Telegram-бот для руководителя и менеджеров",
          ].map((text) => (
            <div key={text} className="flex items-start gap-3">
              <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-gray-600">{text}</p>
            </div>
          ))}
        </div>
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl text-sm transition-colors"
        >
          {connecting ? (
            <><Loader2 className="w-4 h-4 animate-spin" />Открываем AmoCRM...</>
          ) : (
            <><ExternalLink className="w-4 h-4" />Подключить AmoCRM</>
          )}
        </button>
        <p className="text-center text-xs text-gray-400 mt-4">
          Вы будете перенаправлены на страницу авторизации AmoCRM.
          <br />
          Мы запрашиваем только доступ на чтение данных.
        </p>
        {hasAccount && (
          <button onClick={() => router.push("/dashboard")} className="w-full mt-3 text-sm text-gray-500 hover:text-gray-700 py-2">
            Вернуться в дашборд →
          </button>
        )}
      </div>
    </div>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-gray-400" /></div>}>
      <ConnectContent />
    </Suspense>
  );
}
