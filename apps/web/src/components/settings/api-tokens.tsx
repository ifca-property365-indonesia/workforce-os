"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, KeyRound, Plus } from "lucide-react";
import { useStepUp } from "@/components/account/step-up";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  markUntrusted: boolean;
  user?: { id: string; name: string; email: string };
}

interface TokenList {
  tokens: ApiToken[];
  mcpUrl: string;
}

/** Every token expires: a year at most, for everyone. */
const EXPIRY_CHOICES = ["30", "90", "180", "365"] as const;
type Expiry = (typeof EXPIRY_CHOICES)[number];

function state(t: ApiToken): "active" | "revoked" | "expired" {
  if (t.revokedAt) return "revoked";
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

/** The `claude mcp add` line for a token (the token is only known right after creation). */
function claudeCommand(mcpUrl: string, token: string) {
  // i18n-ignore: a shell command, the same in every language
  return `claude mcp add --transport http workforce-os ${mcpUrl} --header "Authorization: Bearer ${token}"`;
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    // clipboard blocked (http, permissions): the text stays selectable in the dialog
  }
}

/** Personal API tokens for the workforce-os MCP server; OWNER/ADMIN also see (and can revoke) everyone's tokens. */
export function ApiTokensSettings({ admin }: { admin: boolean }) {
  const t = useTranslations("apitokens");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const withStepUp = useStepUp();
  const { data: me } = useMe();
  const mine = useQuery({ queryKey: ["api-tokens"], queryFn: () => api.get<TokenList>("/api/me/api-tokens") });
  const all = useQuery({ queryKey: ["api-tokens", "all"], queryFn: () => api.get<TokenList>("/api/me/api-tokens?all=1"), enabled: admin });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("90");
  const [markUntrusted, setMarkUntrusted] = useState(true);
  const [created, setCreated] = useState<{ token: string; mcpUrl: string } | null>(null);
  const needs2fa = me ? !me.user.twoFactorEnabled : false;
  const canCreate = me ? me.role !== "VIEWER" : false;

  const refresh = () => void qc.invalidateQueries({ queryKey: ["api-tokens"] });

  const create = useMutation({
    mutationFn: () =>
      withStepUp(() =>
        api.post<{ token: string; mcpUrl: string }>("/api/me/api-tokens", { name: name.trim(), expiresInDays: Number(expiry), markUntrusted }),
      ),
    onSuccess: (r) => {
      if (!r) return;
      setOpen(false);
      setName("");
      setExpiry("90");
      setMarkUntrusted(true);
      setCreated({ token: r.token, mcpUrl: r.mcpUrl });
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/me/api-tokens/${id}`),
    onSuccess: () => {
      toast.success(t("revoked"));
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const askRevoke = (tok: ApiToken) => {
    if (confirm(t("revokeConfirm", { name: tok.name }))) revoke.mutate(tok.id);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" />
              {t("title")}
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          {canCreate && (
            <Button size="sm" className="shrink-0 gap-1" disabled={needs2fa} onClick={() => setOpen(true)}>
              <Plus className="size-4" />
              {t("create")}
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {canCreate && needs2fa && (
            <Alert>
              <AlertDescription>
                <span>
                  {t("needs2fa")}{" "}
                  <a className="underline" href="/account">
                    {t("goToAccount")}
                  </a>
                </span>
              </AlertDescription>
            </Alert>
          )}
          <TokenTable tokens={mine.data?.tokens ?? []} onRevoke={askRevoke} busy={revoke.isPending} />
          <p className="text-xs text-muted-foreground">{t("rateLimitNote")}</p>
        </CardContent>
      </Card>

      {admin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("allTitle")}</CardTitle>
            <CardDescription>{t("allDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <TokenTable tokens={all.data?.tokens ?? []} onRevoke={askRevoke} busy={revoke.isPending} showUser />
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>{t("createDescription")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="api-token-name">{tc("name")}</Label>
              <Input id="api-token-name" maxLength={80} placeholder={t("namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="api-token-expiry">{t("expiry")}</Label>
              <select id="api-token-expiry" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
                {EXPIRY_CHOICES.map((x) => (
                  <option key={x} value={x}>
                    {t("expiryDays", { days: Number(x) })}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox id="api-token-untrusted" className="mt-0.5" checked={markUntrusted} onCheckedChange={(v) => setMarkUntrusted(v === true)} />
              <div className="space-y-0.5">
                <Label htmlFor="api-token-untrusted">{t("markUntrusted")}</Label>
                <p className="text-xs text-muted-foreground">{t("markUntrustedHelp")}</p>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {tc("cancel")}
              </Button>
              <Button disabled={create.isPending || !name.trim()}>{tc("create")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("createdTitle")}</DialogTitle>
            <DialogDescription>{t("createdWarning")}</DialogDescription>
          </DialogHeader>
          {created && (
            <div className="min-w-0 space-y-4">
              <div className="space-y-1.5">
                <Label>{t("tokenLabel")}</Label>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md border bg-muted px-2 py-1.5 text-xs">{created.token}</code>
                  <Button size="sm" variant="outline" className="shrink-0 gap-1" onClick={() => copy(created.token, tc("copied"))}>
                    <Copy className="size-3.5" />
                    {tc("copy")}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>{t("claudeCodeLabel")}</Label>
                <div className="flex items-start gap-2">
                  <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border bg-muted px-2 py-1.5 text-xs">{claudeCommand(created.mcpUrl, created.token)}</pre>
                  <Button size="sm" variant="outline" className="shrink-0 gap-1" onClick={() => copy(claudeCommand(created.mcpUrl, created.token), tc("copied"))}>
                    <Copy className="size-3.5" />
                    {tc("copy")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("claudeCodeHint")}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>{tc("close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TokenTable({ tokens, onRevoke, busy, showUser }: { tokens: ApiToken[]; onRevoke: (t: ApiToken) => void; busy: boolean; showUser?: boolean }) {
  const t = useTranslations("apitokens");
  const tc = useTranslations("common");
  const f = useFormat();
  if (!tokens.length) return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tc("name")}</TableHead>
            {showUser && <TableHead>{t("colUser")}</TableHead>}
            <TableHead>{t("colPrefix")}</TableHead>
            <TableHead>{t("colCreated")}</TableHead>
            <TableHead>{t("colLastUsed")}</TableHead>
            <TableHead>{t("colExpires")}</TableHead>
            <TableHead>{t("colStatus")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((tok) => {
            const st = state(tok);
            return (
              <TableRow key={tok.id}>
                <TableCell className="font-medium">
                  {tok.name}
                  {tok.markUntrusted && (
                    <Badge variant="outline" className="ml-2 font-normal">
                      {t("untrustedBadge")}
                    </Badge>
                  )}
                </TableCell>
                {showUser && <TableCell className="text-xs">{tok.user ? `${tok.user.name} · ${tok.user.email}` : null}</TableCell>}
                <TableCell>
                  <code className="text-xs">{`${tok.prefix}…`}</code>
                </TableCell>
                <TableCell className="text-xs">{f.date(tok.createdAt)}</TableCell>
                <TableCell className="text-xs">{tok.lastUsedAt ? f.ago(tok.lastUsedAt) : tc("never")}</TableCell>
                <TableCell className="text-xs">{tok.expiresAt ? f.date(tok.expiresAt) : t("expiryNever")}</TableCell>
                <TableCell>
                  <Badge variant={st === "active" ? "secondary" : "outline"}>{t(`status.${st}`)}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  {st === "active" && (
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => onRevoke(tok)}>
                      {t("revoke")}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
