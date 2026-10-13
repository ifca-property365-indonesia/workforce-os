"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  AllowListEntry,
  AutonomyLevel,
  BillingPeriod,
  ClientContact,
  ClientStatus,
  CompanyProfile,
  EmployeeStatus,
  InvoiceLine,
  InvoiceStatus,
  OfficeLook,
  OutboundEmailStatus,
  ToolMeta,
  ToolPermission,
  TaskStatus,
  Role,
  TeamResponderMode,
} from "@wfos/shared";
import type { RoleTemplate } from "@wfos/templates";
import { api } from "./api";

export interface Me {
  user: { id: string; email: string; name: string; mustChangePassword: boolean; hasPassword: boolean; twoFactorEnabled: boolean; mustEnroll2fa: boolean; locale: "id" | "en" | null; telegramLinked: boolean };
  telegramEnabled: boolean;
  workspace: { id: string; name: string; killSwitch: boolean; demoMode: boolean; guardsEnabled: boolean; defaultLocale: "id" | "en" | null };
  role: Role;
  workspaces: { id: string; name: string; role: Role }[];
  claude: { credentialPresent: boolean; source: "workspace" | "instance" | null; type: "oauth" | "api_key" | null };
  googleEnabled: boolean;
}

export interface Employee {
  id: string;
  name: string;
  avatar: string;
  role: string;
  templateKey: string | null;
  persona: string;
  instructions: string;
  businessContext: string;
  model: string;
  autonomyLevel: AutonomyLevel;
  toolPermissions: ToolPermission[];
  allowList: AllowListEntry[];
  dailyBudget: number;
  outputLanguage: "inherit" | "id" | "en";
  executionMode: "tool" | "workspace";
  department: string | null;
  egressDomains: string[];
  look: OfficeLook | null;
  status: EmployeeStatus;
  instructionsVersion: number;
  spentToday?: number;
  createdAt: string;
}

export interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  /** 0..100 reported by the assignee, or derived from subtasks (progressDerived); null = unknown */
  progress: number | null;
  progressNote: string | null;
  progressAt: string | null;
  progressDerived: boolean;
  source: string;
  assigneeId: string | null;
  teamId: string | null;
  parentTaskId: string | null;
  clientId: string | null;
  projectId: string | null;
  dryRun: boolean;
  phase: string | null;
  costCredits: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientProject {
  id: string;
  name: string;
  status: string;
  description: string;
  hourlyRate: number;
  clientId: string;
  deadline: string | null;
  progress: number;
  lastActivityAt: string;
  health: "late" | "at_risk" | "on_track" | "done";
  daysToDeadline: number | null;
  idleDays: number;
  reasons: ("past_deadline" | "deadline_soon" | "no_activity")[];
}

/** a client as the list and detail APIs return it: contacts parsed, receivables and recurring billing summed */
export interface ClientSummary {
  id: string;
  name: string;
  email: string;
  contacts: ClientContact[];
  notes: string;
  currency: string;
  status: ClientStatus;
  legalName: string;
  taxId: string;
  address: string;
  phone: string;
  /** active recurring billing per month, before tax */
  recurringMonthly: number;
  /** total of sent, unpaid invoices */
  outstanding: number;
  /** sent invoices past their due date */
  overdue: number;
  createdAt: string;
}

export interface Client extends ClientSummary {
  projects: ClientProject[];
}

export interface RecurringBilling {
  id: string;
  clientId: string;
  projectId: string | null;
  description: string;
  amount: number;
  taxPercent: number;
  dueDays: number;
  period: BillingPeriod;
  dayOfMonth: number;
  startMonth: number | null;
  active: boolean;
  employeeId: string | null;
  recipients: string[];
  lastPeriod: string | null;
  nextRunAt: string | null;
}

export interface Invoice {
  id: string;
  clientId: string;
  projectId: string | null;
  number: string;
  currency: string;
  lines: InvoiceLine[];
  subtotal: number;
  taxPercent: number;
  tax: number;
  total: number;
  dueDate: string | null;
  status: InvoiceStatus;
  period: string | null;
  recurringId: string | null;
  sentAt: string | null;
  paidAt: string | null;
  createdAt: string;
  /** sent and past its due date */
  overdue: boolean;
}

export interface ClientDetail {
  timezone: string;
  client: ClientSummary;
  projects: ClientProject[];
  recurring: RecurringBilling[];
  invoices: Invoice[];
  history: {
    tasks: { id: string; title: string; status: TaskStatus; updatedAt: string }[];
    emails: { id: string; kind: "email" | "invoice"; subject: string; status: OutboundEmailStatus; to: string[]; error: string | null; createdAt: string; sentAt: string | null }[];
    invoices: { id: string; number: string; status: InvoiceStatus; total: number; currency: string; createdAt: string; sentAt: string | null; paidAt: string | null }[];
  };
}

export interface Team {
  id: string;
  name: string;
  description: string;
  leadId: string | null;
  /** who answers an un-mentioned message in the team chat */
  responderMode: TeamResponderMode;
  memberIds: string[];
}

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me") });
export const useEmployees = () =>
  useQuery({ queryKey: ["employees"], queryFn: () => api.get<{ employees: Employee[] }>("/api/employees").then((r) => r.employees) });
export const useTemplates = (enabled = true) =>
  useQuery({ queryKey: ["templates"], queryFn: () => api.get<{ templates: RoleTemplate[]; tools: ToolMeta[] }>("/api/templates"), staleTime: Infinity, enabled });
export const useClients = () => useQuery({ queryKey: ["clients"], queryFn: () => api.get<{ clients: Client[] }>("/api/clients").then((r) => r.clients) });
/** query keys: ["client", id] for one client's page (projects, billing, ledger, history) */
export const clientQueryKey = (id: string) => ["client", id] as const;
export const useClient = (id: string) => useQuery({ queryKey: clientQueryKey(id), queryFn: () => api.get<ClientDetail>(`/api/clients/${id}`) });
/** the company profile (Settings → Company): Members and up may read it */
export const useCompanyProfile = (enabled = true) =>
  useQuery({ queryKey: ["company"], queryFn: () => api.get<{ company: CompanyProfile }>("/api/settings/company").then((r) => r.company), enabled });
export const useTeams = () => useQuery({ queryKey: ["teams"], queryFn: () => api.get<{ teams: Team[] }>("/api/teams").then((r) => r.teams) });
