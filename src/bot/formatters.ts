/**
 * Telegram message formatters — convert structured data to readable text.
 * All output is plain text or MarkdownV2 where noted.
 */

/** Escape special MarkdownV2 characters */
export function md(text: string | number): string {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/** Format a number as a currency string */
export function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(1)} млн ₽`;
  }
  if (amount >= 1_000) {
    return `${(amount / 1_000).toFixed(0)} тыс ₽`;
  }
  return `${amount} ₽`;
}

/** Format a percentage */
export function formatPct(value: number): string {
  return `${Math.round(value)}%`;
}

/** Format days */
export function formatDays(days: number): string {
  const d = Math.round(days);
  if (d === 1) return "1 день";
  if (d >= 2 && d <= 4) return `${d} дня`;
  return `${d} дней`;
}

/** Format minutes as hours/minutes */
export function formatMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}ч ${rem}мин` : `${h}ч`;
}

// ─── Report formatters ────────────────────────────────────────────────────────

type KpiSummary = {
  manager: string;
  revenue_won: number;
  deals_won: number;
  win_rate_pct: number;
  calls_made: number;
  response_time_p50_min: number;
};

export function formatKpiReport(kpis: KpiSummary[], period: string): string {
  const header = `📊 *Отчёт команды за ${period}*\n\n`;
  if (kpis.length === 0) return header + "_Нет данных за период_";

  const rows = kpis
    .map((k, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      return (
        `${medal} *${md(k.manager)}*\n` +
        `   Выручка: ${md(formatCurrency(k.revenue_won))} · ` +
        `Сделки: ${md(k.deals_won)} · ` +
        `Win: ${md(formatPct(k.win_rate_pct))} · ` +
        `Звонки: ${md(k.calls_made)}`
      );
    })
    .join("\n\n");

  return header + rows;
}

type DealItem = {
  name: string;
  price: number;
  stage: string;
  days_inactive?: number;
};

export function formatDealsList(deals: DealItem[], title: string): string {
  if (deals.length === 0) return `*${md(title)}*\n\n_Нет сделок_`;

  const rows = deals
    .map((d, i) => {
      let line = `${i + 1}\\. *${md(d.name)}* — ${md(formatCurrency(d.price))}\n` +
        `   Этап: ${md(d.stage)}`;
      if (d.days_inactive != null) {
        line += ` · Без активности: ${md(formatDays(d.days_inactive))}`;
      }
      return line;
    })
    .join("\n\n");

  return `*${md(title)}*\n\n${rows}`;
}

type TaskItem = {
  text: string;
  due: Date | string | null;
  completed: boolean;
};

export function formatTasksList(tasks: TaskItem[], managerName: string): string {
  const open = tasks.filter((t) => !t.completed);
  if (open.length === 0) {
    return `✅ У ${md(managerName)} нет открытых задач\\.`;
  }

  const rows = open
    .map((t) => {
      const dueStr = t.due ? new Date(t.due).toLocaleDateString("ru-RU") : "без срока";
      return `• ${md(t.text)} \\(${md(dueStr)}\\)`;
    })
    .join("\n");

  return `📋 *Задачи: ${md(managerName)}*\n\n${rows}`;
}

type FunnelStage = {
  from_stage: string;
  to_stage: string;
  count: number;
  avg_time_hours: number;
};

export function formatFunnel(transitions: FunnelStage[], pipelineName: string): string {
  if (transitions.length === 0) {
    return `*Воронка: ${md(pipelineName)}*\n\n_Нет данных_`;
  }

  const rows = transitions
    .map(
      (t) =>
        `${md(t.from_stage)} → ${md(t.to_stage)}: ${md(t.count)} сделок, avg ${md(t.avg_time_hours)}ч`
    )
    .join("\n");

  return `📊 *Воронка: ${md(pipelineName)}*\n\n${rows}`;
}
