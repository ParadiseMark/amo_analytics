import axios, { AxiosInstance, AxiosError } from "axios";
import { redisCache } from "../../lib/redis/index.js";
import { env } from "../../config/env.js";
import {
  getTokens,
  saveTokens,
  markNeedsReauth,
  isTokenExpiringSoon,
} from "./TokenManager.js";
import type {
  TokenResponse,
  AmoAccount,
  AmoUser,
  AmoPipeline,
  AmoCustomField,
  AmoDeal,
  AmoContact,
  AmoCompany,
  AmoTask,
  AmoNote,
  AmoCall,
  AmoEvent,
  AmoPage,
} from "./types.js";

const RATE_LIMIT_RPS = 4; // 4 req/sec (hard limit is 7, we leave buffer)
const RATE_WINDOW_MS = 1000;
const MAX_PAGE_SIZE = 250;

// ─── Rate limiter (sliding window via Redis) ──────────────────────────────────

async function acquireRateLimit(accountId: string): Promise<void> {
  const key = `amo:rl:${accountId}`;
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;

  // Sliding window: remove old timestamps, count current, add new
  const pipeline = redisCache.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zcard(key);
  pipeline.zadd(key, now, `${now}-${Math.random()}`);
  pipeline.expire(key, 5);

  const results = await pipeline.exec();
  const currentCount = (results?.[1]?.[1] as number) ?? 0;

  if (currentCount >= RATE_LIMIT_RPS) {
    // Wait until the oldest entry in the window expires
    const oldest = await redisCache.zrange(key, 0, 0, "WITHSCORES");
    if (oldest.length >= 2) {
      const oldestTime = parseInt(oldest[1]);
      const waitMs = Math.max(0, oldestTime + RATE_WINDOW_MS - now + 10);
      await sleep(waitMs);
    }
  }
}

// ─── AmoClient ────────────────────────────────────────────────────────────────

export class AmoClient {
  private accountId: string;
  private subdomain: string;
  private http: AxiosInstance;
  // Per-instance refresh lock to prevent concurrent refreshes
  private refreshLock: Promise<string> | null = null;

  constructor(accountId: string, subdomain: string) {
    this.accountId = accountId;
    this.subdomain = subdomain;
    this.http = axios.create({
      baseURL: `https://${subdomain}.amocrm.ru/api/v4`,
      timeout: 30_000,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Token management ───────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    // If a refresh is already running, wait for it
    if (this.refreshLock) {
      return this.refreshLock;
    }

    const tokens = await getTokens(this.accountId);

    if (!isTokenExpiringSoon(tokens.expiresAt)) {
      return tokens.accessToken;
    }

    // Token is expiring — refresh it
    this.refreshLock = this.doRefresh(tokens.refreshToken).finally(() => {
      this.refreshLock = null;
    });

    return this.refreshLock;
  }

  private async doRefresh(refreshToken: string): Promise<string> {
    const url = `https://${this.subdomain}.amocrm.ru/oauth2/access_token`;
    const response = await axios.post<TokenResponse>(url, {
      client_id: env.AMOCRM_CLIENT_ID,
      client_secret: env.AMOCRM_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      redirect_uri: env.AMOCRM_REDIRECT_URI,
    });
    const { access_token, refresh_token, expires_in } = response.data;
    await saveTokens(this.accountId, access_token, refresh_token, expires_in);
    return access_token;
  }

  // ─── Core request method ────────────────────────────────────────────────────

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: {
      params?: Record<string, unknown>;
      data?: unknown;
      retries?: number;
    } = {}
  ): Promise<T> {
    const { params, data, retries = 3 } = options;

    await acquireRateLimit(this.accountId);

    let accessToken = await this.getAccessToken();

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.http.request<T>({
          method,
          url: path,
          params,
          data,
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        return response.data;
      } catch (err) {
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;

        if (status === 401 && attempt === 0) {
          // Token might have just expired — force refresh once
          accessToken = await this.doRefresh(
            (await getTokens(this.accountId)).refreshToken
          );
          continue;
        }

        if (status === 429) {
          // Rate limit hit — wait with exponential backoff
          const delay = Math.pow(2, attempt) * 1000;
          await sleep(delay);
          continue;
        }

        if (status === 504 && attempt < retries) {
          // Gateway timeout — retry
          await sleep(2000);
          continue;
        }

        if (status === 401) {
          // Still 401 after refresh — token is invalid, mark for reauth
          await markNeedsReauth(this.accountId);
          throw new AmoAuthError(`Account ${this.accountId} needs reauthorization`);
        }

        throw err;
      }
    }

    throw new Error(`Request to ${path} failed after ${retries} retries`);
  }

  // ─── Paginated GET helper ───────────────────────────────────────────────────

  async *paginate<T>(
    path: string,
    embeddedKey: string,
    params: Record<string, unknown> = {}
  ): AsyncGenerator<T[]> {
    let page = 1;
    while (true) {
      let response: AmoPage<T>;
      try {
        response = await this.request<AmoPage<T>>("GET", path, {
          params: { ...params, page, limit: MAX_PAGE_SIZE },
        });
      } catch (err) {
        const axiosErr = err as AxiosError;
        // 204 = no content, 404 = no records of this type — treat both as empty
        if (axiosErr.response?.status === 204 || axiosErr.response?.status === 404) break;
        throw err;
      }

      const items = response._embedded?.[embeddedKey];
      if (!items || items.length === 0) break;

      yield items;

      if (!response._links?.next) break;
      page++;
    }
  }

  // ─── Account ────────────────────────────────────────────────────────────────

  getAccount(): Promise<AmoAccount> {
    return this.request<AmoAccount>("GET", "/account");
  }

  // ─── Users ──────────────────────────────────────────────────────────────────

  getUsers(): Promise<AmoPage<AmoUser>> {
    return this.request<AmoPage<AmoUser>>("GET", "/users", {
      params: { limit: 250 },
    });
  }

  // ─── Pipelines ──────────────────────────────────────────────────────────────

  getPipelines(): Promise<AmoPage<AmoPipeline>> {
    return this.request<AmoPage<AmoPipeline>>("GET", "/leads/pipelines", {
      params: { limit: 250 },
    });
  }

  // ─── Custom fields ───────────────────────────────────────────────────────────

  getCustomFields(entityType: "leads" | "contacts" | "companies" | "tasks") {
    return this.paginate<AmoCustomField>(`/${entityType}/custom_fields`, "custom_fields");
  }

  // ─── Deals ──────────────────────────────────────────────────────────────────

  getDeals(params: Record<string, unknown> = {}) {
    return this.paginate<AmoDeal>("/leads", "leads", {
      with: "contacts,companies,tags",
      ...params,
    });
  }

  getDeal(id: number): Promise<AmoDeal> {
    return this.request<AmoDeal>("GET", `/leads/${id}`, {
      params: { with: "contacts,companies,tags" },
    });
  }

  // ─── Contacts ────────────────────────────────────────────────────────────────

  getContacts(params: Record<string, unknown> = {}) {
    return this.paginate<AmoContact>("/contacts", "contacts", params);
  }

  getContact(id: number): Promise<AmoContact> {
    return this.request<AmoContact>("GET", `/contacts/${id}`);
  }

  // ─── Companies ───────────────────────────────────────────────────────────────

  getCompanies(params: Record<string, unknown> = {}) {
    return this.paginate<AmoCompany>("/companies", "companies", params);
  }

  // ─── Tasks ───────────────────────────────────────────────────────────────────

  getTasks(params: Record<string, unknown> = {}) {
    return this.paginate<AmoTask>("/tasks", "tasks", params);
  }

  // ─── Notes ───────────────────────────────────────────────────────────────────

  getNotes(entityType: "leads" | "contacts", params: Record<string, unknown> = {}) {
    return this.paginate<AmoNote>(`/${entityType}/notes`, "notes", params);
  }

  // ─── Calls (stored as notes with call_in/call_out type) ─────────────────────

  getCalls(params: Record<string, unknown> = {}) {
    return this.paginate<AmoCall>("/calls", "calls", params);
  }

  // ─── Events ──────────────────────────────────────────────────────────────────

  getEvents(params: Record<string, unknown> = {}) {
    return this.paginate<AmoEvent>("/events", "events", {
      entity_type: "leads",
      ...params,
    });
  }
}

// ─── Client cache (one instance per account) ─────────────────────────────────

const clientCache = new Map<string, AmoClient>();

export function getAmoClient(accountId: string, subdomain: string): AmoClient {
  const key = `${accountId}:${subdomain}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, new AmoClient(accountId, subdomain));
  }
  return clientCache.get(key)!;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AmoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmoAuthError";
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
