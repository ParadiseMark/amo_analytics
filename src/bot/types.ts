/**
 * Shared types for the Telegram bot.
 */

export type BotUserRole = "supervisor" | "manager";

export type BotSession = {
  accountId: string;
  platformUserId: string;
  role: BotUserRole;
  userAmoId: number | null;
  /** ISO date string, updated each message */
  lastSeen: string;
};
