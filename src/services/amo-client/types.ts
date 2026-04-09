// ─── OAuth ────────────────────────────────────────────────────────────────────

export type TokenResponse = {
  token_type: "Bearer";
  expires_in: number;
  access_token: string;
  refresh_token: string;
};

// ─── Pagination ───────────────────────────────────────────────────────────────

export type AmoPage<T> = {
  _page: number;
  _links: { self: { href: string }; next?: { href: string } };
  _embedded: Record<string, T[]>;
};

// ─── Account ──────────────────────────────────────────────────────────────────

export type AmoAccount = {
  id: number;
  name: string;
  subdomain: string;
  timezone: string;
  currency: string;
};

// ─── Users ────────────────────────────────────────────────────────────────────

export type AmoUser = {
  id: number;
  name: string;
  email: string;
  role: { id: number; name: string };
  is_active: boolean;
};

// ─── Pipelines ────────────────────────────────────────────────────────────────

export type AmoStatus = {
  id: number;
  name: string;
  sort: number;
  type: number;
  color: string;
  pipeline_id: number;
};

export type AmoPipeline = {
  id: number;
  name: string;
  sort: number;
  is_main: boolean;
  is_deleted: boolean;
  _embedded: { statuses: AmoStatus[] };
};

// ─── Custom fields ────────────────────────────────────────────────────────────

export type AmoFieldEnum = {
  id: number;
  value: string;
  sort: number;
};

export type AmoCustomField = {
  id: number;
  name: string;
  type: string;
  sort: number;
  is_system: boolean;
  enums?: AmoFieldEnum[];
};

// ─── Deals ────────────────────────────────────────────────────────────────────

export type AmoCustomFieldValue = {
  field_id: number;
  field_name?: string;
  field_type?: string;
  values: Array<{
    value?: string | number | boolean;
    enum_id?: number;
    enum_value?: string;
  }>;
};

export type AmoTag = { id: number; name: string };

export type AmoDeal = {
  id: number;
  name: string;
  price: number;
  status_id: number;
  pipeline_id: number;
  responsible_user_id: number;
  created_at: number; // unix
  updated_at: number;
  closed_at: number | null;
  is_deleted: boolean;
  custom_fields_values: AmoCustomFieldValue[] | null;
  _embedded?: {
    tags?: AmoTag[];
    contacts?: Array<{ id: number }>;
    companies?: Array<{ id: number }>;
  };
};

// ─── Contacts ─────────────────────────────────────────────────────────────────

export type AmoContact = {
  id: number;
  name: string;
  responsible_user_id: number;
  created_at: number;
  updated_at: number;
  is_deleted: boolean;
  custom_fields_values: AmoCustomFieldValue[] | null;
};

// ─── Companies ────────────────────────────────────────────────────────────────

export type AmoCompany = {
  id: number;
  name: string;
  responsible_user_id: number;
  created_at: number;
  updated_at: number;
  is_deleted: boolean;
  custom_fields_values: AmoCustomFieldValue[] | null;
};

// ─── Tasks ────────────────────────────────────────────────────────────────────

export type AmoTask = {
  id: number;
  responsible_user_id: number;
  entity_id: number;
  entity_type: string;
  task_type_id: number;
  text: string;
  complete_till: number;
  is_completed: boolean;
  created_at: number;
  updated_at: number;
};

// ─── Notes ────────────────────────────────────────────────────────────────────

export type AmoNote = {
  id: number;
  responsible_user_id: number;
  entity_id: number;
  entity_type: string;
  note_type: string;
  params: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

// ─── Calls ────────────────────────────────────────────────────────────────────

export type AmoCall = {
  id: number;
  responsible_user_id: number;
  entity_id: number;
  entity_type: string;
  note_type: "call_in" | "call_out";
  params: {
    duration: number;
    source: string;
    link?: string;
    phone: string;
    call_status: number;
    call_result?: string;
  };
  created_at: number;
};

// ─── Events ───────────────────────────────────────────────────────────────────

export type AmoEvent = {
  id: string;
  type: string;
  entity_id: number;
  entity_type: string;
  created_by: number;
  created_at: number;
  value_after?: Array<{ note?: { text: string } }>;
  value_before?: Array<{ note?: { text: string } }>;
};
