/**
 * Scheduled reports worker.
 *
 * For each report with a schedule field, a BullMQ repeatable job is registered.
 * When triggered:
 *   1. Run the report query (ClickHouse)
 *   2. Format result as an HTML table
 *   3. Send via Postmark to the recipients list
 *
 * No Puppeteer PDF for now — HTML email is simpler and works everywhere.
 * PDF generation can be added later as a separate step.
 */
import { Worker, Queue } from "bullmq";
import { redis } from "../../lib/redis/index.js";
import { db } from "../../lib/db/index.js";
import { reportDefinitions } from "../../lib/db/schema.js";
import { eq } from "drizzle-orm";
import { runReport } from "../../reports/reports.service.js";
import { ReportDslSchema } from "../../reports/dsl.js";
import { env } from "../../config/env.js";

export type ScheduledReportJobData = {
  accountId: string;
  reportId: string;
};

// ─── Queue ────────────────────────────────────────────────────────────────────

const scheduledReportQueues = new Map<string, Queue<ScheduledReportJobData>>();

function getScheduledReportQueue(accountId: string) {
  if (!scheduledReportQueues.has(accountId)) {
    scheduledReportQueues.set(
      accountId,
      new Queue(`scheduled-reports-${accountId}`, { connection: redis })
    );
  }
  return scheduledReportQueues.get(accountId)!;
}

// ─── Register / unregister repeatable jobs for a report ───────────────────────

export async function registerReportSchedule(
  accountId: string,
  reportId: string,
  cron: string
): Promise<void> {
  const queue = getScheduledReportQueue(accountId);
  await queue.add(
    "send-report",
    { accountId, reportId },
    {
      jobId: `scheduled-report:${reportId}`,
      repeat: { pattern: cron },
      removeOnComplete: 10,
      removeOnFail: 20,
    }
  );
}

export async function unregisterReportSchedule(
  accountId: string,
  reportId: string
): Promise<void> {
  const queue = getScheduledReportQueue(accountId);
  const jobs = await queue.getRepeatableJobs();
  for (const job of jobs) {
    if (job.id === `scheduled-report:${reportId}`) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
}

// ─── Bootstrap: register schedules for all reports with a cron ───────────────

export async function bootstrapReportSchedules(): Promise<void> {
  const allReports = await db
    .select({
      id: reportDefinitions.id,
      accountId: reportDefinitions.accountId,
      config: reportDefinitions.config,
    })
    .from(reportDefinitions);

  let registered = 0;
  for (const report of allReports) {
    try {
      const dsl = ReportDslSchema.parse(report.config);
      if (dsl.schedule?.cron) {
        await registerReportSchedule(report.accountId, report.id, dsl.schedule.cron);
        registered++;
      }
    } catch {
      // Skip malformed DSL
    }
  }

  console.log(`[scheduled-reports] Bootstrap: ${registered} scheduled reports registered`);
}

// ─── Email via Postmark ───────────────────────────────────────────────────────

async function sendReportEmail(
  recipients: string[],
  reportName: string,
  htmlBody: string
): Promise<void> {
  if (!env.POSTMARK_API_KEY || !env.POSTMARK_FROM_EMAIL) {
    console.warn("[scheduled-reports] Postmark not configured, skipping email");
    return;
  }

  for (const to of recipients) {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": env.POSTMARK_API_KEY,
      },
      body: JSON.stringify({
        From: env.POSTMARK_FROM_EMAIL,
        To: to,
        Subject: `[AMO Analytics] ${reportName}`,
        HtmlBody: htmlBody,
        MessageStream: "outbound",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[scheduled-reports] Postmark error for ${to}: ${res.status} ${body}`);
    }
  }
}

// ─── HTML table renderer ──────────────────────────────────────────────────────

function renderHtmlTable(
  reportName: string,
  columns: string[],
  rows: Record<string, unknown>[]
): string {
  const th = columns
    .map((c) => `<th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb;font-size:12px;text-transform:uppercase;color:#6b7280">${c}</th>`)
    .join("");
  const tbody = rows
    .map((row) => {
      const tds = columns
        .map((c) => `<td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151">${row[c] ?? "—"}</td>`)
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,sans-serif;margin:0;padding:24px;background:#f9fafb">
  <div style="max-width:800px;margin:0 auto">
    <h1 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 4px">${reportName}</h1>
    <p style="font-size:13px;color:#6b7280;margin:0 0 20px">
      Сформировано: ${new Date().toLocaleString("ru-RU")} · ${rows.length} строк
    </p>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">
      <thead><tr>${th}</tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <p style="font-size:11px;color:#9ca3af;margin-top:16px">AMO Analytics — автоматический отчёт</p>
  </div>
</body>
</html>`;
}

// ─── Worker factory ───────────────────────────────────────────────────────────

export function createScheduledReportsWorker(accountId: string): Worker<ScheduledReportJobData> {
  return new Worker<ScheduledReportJobData>(
    `scheduled-reports-${accountId}`,
    async (job) => {
      const { reportId } = job.data;

      const report = await db.query.reportDefinitions.findFirst({
        where: eq(reportDefinitions.id, reportId),
      });
      if (!report) {
        console.warn(`[scheduled-reports] Report ${reportId} not found, skipping`);
        return;
      }

      const dsl = ReportDslSchema.parse(report.config);
      if (!dsl.schedule?.recipients?.length) return;

      const result = await runReport(job.data.accountId, reportId, true);

      const html = renderHtmlTable(report.name, result.columns, result.rows);
      await sendReportEmail(dsl.schedule.recipients, report.name, html);

      console.log(
        `[scheduled-reports] Sent report "${report.name}" to ${dsl.schedule.recipients.join(", ")}`
      );
    },
    {
      connection: redis,
      concurrency: 2,
    }
  );
}
