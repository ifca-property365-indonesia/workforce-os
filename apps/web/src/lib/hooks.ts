"use client";

import { useQuery } from "@tanstack/react-query";
import type { AllowListEntry, AutonomyLevel, EmployeeStatus, ToolMeta, ToolPermission, TaskStatus, Role } from "@wfos/shared";
import type { RoleTemplate } from "@wfos/templates";
import { api } from "./api";

export interface Me {
  user: { id: string; email: string; name: string; mustChangePassword: boolean; hasPassword: boolean; twoFactorEnabled: boolean; mustEnroll2fa: boolean; locale: "id" | "en" | null };
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
  egressDomains: string[];
  status: EmployeeStatus;
  instructionsVersion: number;
  spentToday?: number;
  createdAt: string;
}

export interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
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

export interface Client {
  id: string;
  name: string;
  email: string;
  contacts: { name: string; email: string; role: string }[];
  notes: string;
  currency: string;
  projects: {
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
  }[];
}

export interface Team {
  id: string;
  name: string;
  description: string;
  leadId: string | null;
  memberIds: string[];
}

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me") });
export const useEmployees = () =>
  useQuery({ queryKey: ["employees"], queryFn: () => api.get<{ employees: Employee[] }>("/api/employees").then((r) => r.employees) });
export const useTemplates = () =>
  useQuery({ queryKey: ["templates"], queryFn: () => api.get<{ templates: RoleTemplate[]; tools: ToolMeta[] }>("/api/templates"), staleTime: Infinity });
export const useClients = () => useQuery({ queryKey: ["clients"], queryFn: () => api.get<{ clients: Client[] }>("/api/clients").then((r) => r.clients) });
export const useTeams = () => useQuery({ queryKey: ["teams"], queryFn: () => api.get<{ teams: Team[] }>("/api/teams").then((r) => r.teams) });

export function useEmployeeMap() {
  const { data } = useEmployees();
  return new Map((data ?? []).map((e) => [e.id, e]));
}
