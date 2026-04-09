"use client";
import { createContext, useContext } from "react";

export const AccountContext = createContext<string>("");

/** Возвращает активный accountId из контекста layout'а. */
export function useAccountId(): string {
  return useContext(AccountContext);
}
