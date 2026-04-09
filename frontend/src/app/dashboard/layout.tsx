"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMe, useActiveAccount } from "@/lib/hooks";
import { useRouter } from "next/navigation";
import Cookies from "js-cookie";
import {
  LayoutDashboard,
  Users,
  GitBranch,
  AlertTriangle,
  MessageSquare,
  BarChart2,
  Settings,
  LogOut,
  Grid3x3,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AccountContext } from "@/lib/account-context";

const navItems = [
  { href: "/dashboard", label: "Обзор", icon: LayoutDashboard, exact: true },
  { href: "/dashboard/managers", label: "Менеджеры", icon: Users },
  { href: "/dashboard/funnel", label: "Воронка", icon: GitBranch },
  { href: "/dashboard/heatmap", label: "Тепловая карта", icon: Grid3x3 },
  { href: "/dashboard/stuck", label: "Зависшие сделки", icon: AlertTriangle },
  { href: "/dashboard/reports", label: "Отчёты", icon: BarChart2 },
  { href: "/dashboard/ai", label: "AI Ассистент", icon: MessageSquare },
  { href: "/dashboard/settings", label: "Настройки", icon: Settings },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me, isLoading: meLoading } = useMe();
  const { accountId: activeAccountId, setAccountId } = useActiveAccount();

  const account = me?.accounts.find((a) => a.accountId === activeAccountId) ?? me?.accounts[0];
  const noAccount = !meLoading && me && me.accounts.length === 0;

  // Пользователь без аккаунта — показываем экран подключения
  if (noAccount && !pathname.startsWith("/dashboard/connect")) {
    router.replace("/dashboard/connect");
    return null;
  }

  async function handleLogout() {
    const refreshToken = Cookies.get("refresh_token");
    if (refreshToken) {
      await fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    }
    Cookies.remove("access_token");
    Cookies.remove("refresh_token");
    router.push("/login");
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
        {/* Logo */}
        <div className="h-14 flex items-center px-5 border-b border-gray-200">
          <span className="font-bold text-gray-900 text-base">AMO Analytics</span>
        </div>

        {/* Account badge + switcher */}
        {account && (
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Аккаунт</p>
              <Link
                href="/dashboard/connect"
                className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                title="Подключить ещё один аккаунт"
              >
                <Plus className="w-3.5 h-3.5" />
              </Link>
            </div>

            {/* Показываем select только при нескольких аккаунтах */}
            {(me?.accounts.length ?? 0) > 1 ? (
              <select
                value={account.accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full text-sm font-semibold text-gray-800 bg-transparent border-0 p-0 focus:outline-none cursor-pointer truncate"
              >
                {me!.accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.accountName ?? a.subdomain}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-sm font-semibold text-gray-800 truncate">
                {account.accountName ?? account.subdomain}
              </p>
            )}

            <span
              className={cn(
                "inline-flex items-center text-xs mt-1 px-1.5 py-0.5 rounded",
                account.syncStatus === "ready"
                  ? "bg-green-50 text-green-700"
                  : "bg-yellow-50 text-yellow-700"
              )}
            >
              {account.syncStatus === "ready" ? "Синхронизирован" : account.syncStatus}
            </span>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {navItems.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href) && item.href !== "/dashboard";
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  active
                    ? "bg-brand-50 text-brand-700"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                )}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* User footer */}
        <div className="border-t border-gray-200 p-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{me?.user.name}</p>
              <p className="text-xs text-gray-500 truncate">{me?.user.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
              title="Выйти"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <AccountContext.Provider value={account?.accountId ?? ""}>
          {children}
        </AccountContext.Provider>
      </main>
    </div>
  );
}
