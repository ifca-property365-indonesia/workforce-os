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
  TeamMemberRole,
  TeamResponderMode,
} from "@wfos/shared";
import type { RoleTemplate } from "@wfos/templates";
import type { InboxResponse } from "@/components/approvals/decision-items";
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
  /** one line of expertise: how a division head or code lead picks this employee */
  specialty: string;
  egressDomains: string[];
  look: OfficeLook | null;
  status: EmployeeStatus;
  instructionsVersion: number;
  spentToday?: number;
  /** credits over the last 7 days, including work as a subagent in a code lead's run (profile only) */
  credits7d?: number;
  /** the employee's division and their place in it (null: in none) */
  division?: { id: string; key: string | null; name: string; color: string; role: DivisionRole } | null;
  createdAt: string;
}

/** an employee's place in their division: the head and the code lead are set on the division, the rest are members */
export type DivisionRole = "head" | "code_lead" | TeamMemberRole;

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
  /** division responsible: the project's tasks go to it */
  teamId: string | null;
  startDate: string | null;
  nextMilestone: string;
  nextStep: string;
  /** the status the team set (on_track | at_risk | late) */
  statusHealth: "late" | "at_risk" | "on_track";
  statusUpdatedAt: string | null;
  lastActivityAt: string;
  /** the more serious of the computed signal and the team's status */
  health: "late" | "at_risk" | "on_track" | "done";
  daysToDeadline: number | null;
  idleDays: number;
  reasons: ("past_deadline" | "deadline_soon" | "no_activity" | "reported")[];
}

/** a client as the list and detail APIs return it: contacts parsed, receivables and recurring billing summed */
export interface ClientSummary {
  id: string;
  name: string;
  /** short code, e.g. GOB ("" = none) */
  code: string;
  website: string;
  industry: string;
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
  /** this client's work in progress (queued, running, awaiting approval) */
  running: { id: string; title: string; status: TaskStatus; assigneeId: string | null; teamId: string | null; projectId: string | null; parentTaskId: string | null; progress: number | null; updatedAt: string }[];
  history: {
    tasks: { id: string; title: string; status: TaskStatus; updatedAt: string }[];
    emails: { id: string; kind: "email" | "invoice"; subject: string; status: OutboundEmailStatus; to: string[]; error: string | null; createdAt: string; sentAt: string | null }[];
    invoices: { id: string; number: string; status: InvoiceStatus; total: number; currency: string; createdAt: string; sentAt: string | null; paidAt: string | null }[];
  };
}

/** A division (UI "Divisi", stored as a team): head, code lead, members with their role, workload and spend. */
export interface Team {
  id: string;
  key: string | null;
  name: string;
  description: string;
  /** "#rrggbb", "" = dealt from the id */
  color: string;
  sop: { en: string; id: string };
  /** the head: takes division tasks, does them or delegates */
  leadId: string | null;
  /** works in a sandbox; the subagent members work inside that run */
  codeLeadId: string | null;
  maxParallel: number;
  dailyBudget: number | null;
  sortOrder: number;
  /** who answers an un-mentioned message in the team chat */
  responderMode: TeamResponderMode;
  members: { employeeId: string; role: TeamMemberRole; credits7d: number }[];
  workload: { running: number; queued: number };
  credits7d: number;
}
export type Division = Team;

/** everyone in a division, head first (the head may be missing from members in older data) */
export const divisionMemberIds = (t: Pick<Team, "leadId" | "members">) => [...new Set([...(t.leadId ? [t.leadId] : []), ...t.members.map((m) => m.employeeId)])];

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me") });
/**
 * "Needs a decision" (GET /api/inbox): what waits for a person besides approval cards, and the counts. Under the
 * "approvals" key, so every event that refreshes approvals (decisions, task runs ending, employees) refreshes it too.
 */
export const useInbox = () => useQuery({ queryKey: ["approvals", "inbox"], queryFn: () => api.get<InboxResponse>("/api/inbox"), refetchInterval: 60_000 });
/** the one number the menu bar, the dock and the rail show: everything that waits for a person */
export const useDecisionCount = () => useInbox().data?.counts.total ?? 0;
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
/** P1: a goal of the workspace with what was done for it (own numbers and, in `total`, with its sub-goals) */
export interface GoalStats {
  open: number;
  done: number;
  credits: number;
  credits30d: number;
}
export interface Goal {
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  teamId: string | null;
  status: "active" | "done" | "dropped";
  targetDate: string | null;
  position: number;
  createdAt: string;
  stats: GoalStats & { projects: number };
  total: GoalStats;
}
export const goalsQueryKey = ["goals"] as const;
export const useGoals = (enabled = true) => useQuery({ queryKey: goalsQueryKey, queryFn: () => api.get<{ goals: Goal[]; withoutGoal30d: number }>("/api/goals"), enabled });
export const useTeams = () => useQuery({ queryKey: ["teams"], queryFn: () => api.get<{ teams: Team[] }>("/api/teams").then((r) => r.teams) });
