import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { remoteExecutionApi, type RemoteExecutionTargetTestResult } from "../api/remoteExecution";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Save, ServerCog, Settings, Trash2 } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { adapterLabels, Field, ToggleField, HintIcon } from "../components/agent-config-primitives";
import { OrgChart } from "./OrgChart";
import { Costs } from "./Costs";
import { Activity } from "./Activity";
import type {
  AgentAdapterType,
  CreateRemoteExecutionTarget,
  RemoteExecutionTarget,
  TestRemoteExecutionTarget,
  UpdateRemoteExecutionTarget,
} from "@paperclipai/shared";

const SETTINGS_TABS = [
  { key: "general", label: "General" },
  { key: "remote", label: "Remote" },
  { key: "org", label: "Org" },
  { key: "costs", label: "Costs" },
  { key: "activity", label: "Activity" },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];

function isSettingsTab(value: string | undefined): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.key === value);
}

const REMOTE_TARGET_ADAPTER_OPTIONS: AgentAdapterType[] = ["codex_local", "claude_local", "process"];

type RemoteTargetDraft = {
  name: string;
  host: string;
  user: string;
  workerPath: string;
  apiUrl: string;
  setupScript: string;
  supportedAdapters: AgentAdapterType[];
  maxConcurrentLeases: string;
  metadata: Record<string, unknown> | null;
};

function readRemoteTargetSetupScript(metadata: Record<string, unknown> | null | undefined) {
  const value = metadata?.setupScript;
  return typeof value === "string" ? value : "";
}

function withRemoteTargetSetupScript(
  metadata: Record<string, unknown> | null | undefined,
  setupScript: string,
) {
  const next: Record<string, unknown> = { ...(metadata ?? {}) };
  const trimmed = setupScript.trim();
  if (trimmed) {
    next.setupScript = setupScript;
  } else {
    delete next.setupScript;
  }
  return Object.keys(next).length > 0 ? next : null;
}

function buildDefaultRemoteTargetDraft(): RemoteTargetDraft {
  return {
    name: "",
    host: "",
    user: "brewuser",
    workerPath: "~/paperclip-remote-worker/dist/worker.js",
    apiUrl: "",
    setupScript: "",
    supportedAdapters: ["codex_local", "claude_local"],
    maxConcurrentLeases: "1",
    metadata: null,
  };
}

function buildRemoteTargetDraft(target: RemoteExecutionTarget): RemoteTargetDraft {
  return {
    name: target.name,
    host: target.host,
    user: target.user,
    workerPath: target.workerPath,
    apiUrl: target.apiUrl ?? "",
    setupScript: readRemoteTargetSetupScript(target.metadata),
    supportedAdapters: target.supportedAdapters,
    maxConcurrentLeases: String(target.maxConcurrentLeases),
    metadata: target.metadata ?? null,
  };
}

function normalizeRemoteTargetPayload(
  draft: RemoteTargetDraft,
): CreateRemoteExecutionTarget | UpdateRemoteExecutionTarget {
  const parsedMaxConcurrentLeases = Number(draft.maxConcurrentLeases);
  return {
    name: draft.name.trim(),
    host: draft.host.trim(),
    user: draft.user.trim() || "brewuser",
    workerPath: draft.workerPath.trim() || "~/paperclip-remote-worker/dist/worker.js",
    apiUrl: draft.apiUrl.trim() || null,
    supportedAdapters: draft.supportedAdapters,
    maxConcurrentLeases:
      Number.isInteger(parsedMaxConcurrentLeases) && parsedMaxConcurrentLeases > 0
        ? parsedMaxConcurrentLeases
        : 1,
    metadata: withRemoteTargetSetupScript(draft.metadata, draft.setupScript),
  };
}

function normalizeRemoteTargetTestPayload(
  draft: RemoteTargetDraft,
): TestRemoteExecutionTarget {
  return {
    host: draft.host.trim(),
    user: draft.user.trim() || "brewuser",
    workerPath: draft.workerPath.trim() || "~/paperclip-remote-worker/dist/worker.js",
    apiUrl: draft.apiUrl.trim() || null,
    metadata: withRemoteTargetSetupScript(draft.metadata, draft.setupScript),
  };
}

function toggleAdapter(
  adapters: AgentAdapterType[],
  adapter: AgentAdapterType,
): AgentAdapterType[] {
  return adapters.includes(adapter)
    ? adapters.filter((value) => value !== adapter)
    : [...adapters, adapter];
}

function RemoteTargetForm({
  draft,
  onChange,
  disabled,
}: {
  draft: RemoteTargetDraft;
  onChange: (next: RemoteTargetDraft) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="Name" hint="Human-readable label shown when choosing a remote target.">
        <input
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          disabled={disabled}
          placeholder="Tailscale Brew"
        />
      </Field>
      <Field label="Host" hint="SSH host or IP address reachable from the Paperclip server.">
        <input
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
          value={draft.host}
          onChange={(event) => onChange({ ...draft, host: event.target.value })}
          disabled={disabled}
          placeholder="100.122.157.11"
        />
      </Field>
      <Field label="SSH user" hint="Remote SSH username used for worker execution.">
        <input
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
          value={draft.user}
          onChange={(event) => onChange({ ...draft, user: event.target.value })}
          disabled={disabled}
          placeholder="brewuser"
        />
      </Field>
      <Field label="Max concurrent leases" hint="How many issues may hold active remote leases on this target at once.">
        <input
          type="number"
          min="1"
          max="100"
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
          value={draft.maxConcurrentLeases}
          onChange={(event) => onChange({ ...draft, maxConcurrentLeases: event.target.value })}
          disabled={disabled}
        />
      </Field>
      <div className="md:col-span-2">
        <Field label="Worker path" hint="Absolute or home-relative path to the remote worker entrypoint.">
          <input
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
            value={draft.workerPath}
            onChange={(event) => onChange({ ...draft, workerPath: event.target.value })}
            disabled={disabled}
            placeholder="~/paperclip-remote-worker/dist/worker.js"
          />
        </Field>
      </div>
      <div className="md:col-span-2">
        <Field label="API URL" hint="Optional future-facing target API URL. Leave blank for SSH-only targets.">
          <input
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
            value={draft.apiUrl}
            onChange={(event) => onChange({ ...draft, apiUrl: event.target.value })}
            disabled={disabled}
            placeholder="https://target.example.com"
          />
        </Field>
      </div>
      <div className="md:col-span-2">
        <Field
          label="Setup script"
          hint="Optional shell script run once per remote lease after the clean worktree is created. Use this for bootstrap steps like dependency install."
        >
          <textarea
            className="min-h-28 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
            value={draft.setupScript}
            onChange={(event) => onChange({ ...draft, setupScript: event.target.value })}
            disabled={disabled}
            placeholder={"pnpm install --frozen-lockfile\nbundle install"}
          />
        </Field>
      </div>
      <div className="md:col-span-2">
        <Field label="Supported adapters" hint="Only these agent adapter types will be offered for remote execution on this target.">
          <div className="flex flex-wrap gap-2">
            {REMOTE_TARGET_ADAPTER_OPTIONS.map((adapter) => {
              const selected = draft.supportedAdapters.includes(adapter);
              return (
                <button
                  key={adapter}
                  type="button"
                  className={[
                    "rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                    selected
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:bg-accent/50",
                  ].join(" ")}
                  onClick={() => onChange({ ...draft, supportedAdapters: toggleAdapter(draft.supportedAdapters, adapter) })}
                  disabled={disabled}
                >
                  {adapterLabels[adapter] ?? adapter}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
    </div>
  );
}

export function CompanySettings() {
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { companies, selectedCompany, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const activeTab: SettingsTab = isSettingsTab(tab) ? tab : "general";
  const activeTabLabel = useMemo(
    () => SETTINGS_TABS.find((entry) => entry.key === activeTab)?.label ?? "General",
    [activeTab],
  );

  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
  }, [selectedCompany]);

  useEffect(() => {
    if (!tab) {
      navigate("/company/settings/general", { replace: true });
      return;
    }
    if (!isSettingsTab(tab)) {
      navigate("/company/settings/general", { replace: true });
    }
  }, [tab, navigate]);

  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [newRemoteTarget, setNewRemoteTarget] = useState<RemoteTargetDraft>(buildDefaultRemoteTargetDraft());
  const [editingTargets, setEditingTargets] = useState<Record<string, RemoteTargetDraft>>({});
  const [newRemoteTargetTestResult, setNewRemoteTargetTestResult] = useState<RemoteExecutionTargetTestResult | null>(null);
  const [editingTargetTestResults, setEditingTargetTestResults] = useState<Record<string, RemoteExecutionTargetTestResult | null>>({});

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));

  const generalMutation = useMutation({
    mutationFn: (data: { name: string; description: string | null; brandColor: string | null }) =>
      companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "both",
        expiresInHours: 72,
      }),
    onSuccess: (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const absoluteUrl = invite.inviteUrl.startsWith("http")
        ? invite.inviteUrl
        : `${base}${invite.inviteUrl}`;
      setInviteLink(absoluteUrl);
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
    },
    onError: (err) => {
      setInviteError(err instanceof Error ? err.message : "Failed to create invite");
    },
  });
  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId,
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings/general" },
      ...(activeTab === "general" ? [] : [{ label: activeTabLabel }]),
    ]);
  }, [setBreadcrumbs, selectedCompany?.name, activeTab, activeTabLabel]);

  const { data: remoteTargets, isLoading: remoteTargetsLoading } = useQuery({
    queryKey: queryKeys.remoteExecution.targets(selectedCompanyId!),
    queryFn: () => remoteExecutionApi.listTargets(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (!remoteTargets) return;
    setEditingTargets((current) => {
      const next: Record<string, RemoteTargetDraft> = {};
      for (const target of remoteTargets) {
        next[target.id] = current[target.id] ?? buildRemoteTargetDraft(target);
      }
      return next;
    });
  }, [remoteTargets]);

  const remoteTargetsMutation = useMutation({
    mutationFn: (payload: CreateRemoteExecutionTarget) =>
      remoteExecutionApi.createTarget(selectedCompanyId!, payload),
    onSuccess: () => {
      setNewRemoteTarget(buildDefaultRemoteTargetDraft());
      setNewRemoteTargetTestResult(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.remoteExecution.targets(selectedCompanyId!) });
    },
  });

  const testRemoteTargetMutation = useMutation({
    mutationFn: ({
      targetId,
      payload,
    }: {
      targetId: string | null;
      payload: TestRemoteExecutionTarget;
    }) => remoteExecutionApi.testTarget(selectedCompanyId!, payload),
    onSuccess: (result, variables) => {
      if (variables.targetId) {
        setEditingTargetTestResults((current) => ({
          ...current,
          [variables.targetId!]: result,
        }));
      } else {
        setNewRemoteTargetTestResult(result);
      }
    },
  });

  const updateRemoteTargetMutation = useMutation({
    mutationFn: ({ targetId, payload }: { targetId: string; payload: UpdateRemoteExecutionTarget }) =>
      remoteExecutionApi.updateTarget(targetId, payload),
    onSuccess: (updated) => {
      setEditingTargets((current) => ({
        ...current,
        [updated.id]: buildRemoteTargetDraft(updated),
      }));
      queryClient.invalidateQueries({ queryKey: queryKeys.remoteExecution.targets(selectedCompanyId!) });
    },
  });

  const archiveRemoteTargetMutation = useMutation({
    mutationFn: (targetId: string) => remoteExecutionApi.archiveTarget(targetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.remoteExecution.targets(selectedCompanyId!) });
    },
  });

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
    });
  }

  function handleCreateRemoteTarget() {
    const payload = normalizeRemoteTargetPayload(newRemoteTarget) as CreateRemoteExecutionTarget;
    remoteTargetsMutation.mutate(payload);
  }

  function renderRemoteTargetTestResult(result: RemoteExecutionTargetTestResult | null) {
    if (!result) return null;
    return (
      <div
        className={[
          "rounded-md border px-3 py-2 text-xs",
          result.ok
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
            : "border-destructive/40 bg-destructive/10 text-foreground",
        ].join(" ")}
      >
        <div className="font-medium">
          {result.ok ? "Target test succeeded" : "Target test failed"}
        </div>
        {result.errorMessage && !result.ok && (
          <div className="mt-1 break-words font-mono text-[11px] text-muted-foreground">{result.errorMessage}</div>
        )}
        {result.stdout.trim() && (
          <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">stdout</div>
            <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-border/60 bg-background/60 p-2 font-mono text-[11px]">
              {result.stdout.trim()}
            </pre>
          </div>
        )}
        {result.stderr.trim() && (
          <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">stderr</div>
            <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-border/60 bg-background/60 p-2 font-mono text-[11px]">
              {result.stderr.trim()}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Company Settings</h1>
      </div>

      <Tabs value={activeTab} onValueChange={(next) => navigate(`/company/settings/${next}`)} className="space-y-5">
        <TabsList variant="line" className="w-full justify-start gap-1 overflow-x-auto">
          {SETTINGS_TABS.map((settingsTab) => (
            <TabsTrigger key={settingsTab.key} value={settingsTab.key}>
              {settingsTab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="general" className="space-y-6 max-w-2xl">
          <div className="space-y-4">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              General
            </div>
            <div className="space-y-3 rounded-md border border-border px-4 py-4">
              <Field label="Company name" hint="The display name for your company.">
                <input
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                />
              </Field>
              <Field label="Description" hint="Optional description shown in the company profile.">
                <input
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  type="text"
                  value={description}
                  placeholder="Optional company description"
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
            </div>
          </div>

          <div className="space-y-4">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Appearance
            </div>
            <div className="space-y-3 rounded-md border border-border px-4 py-4">
              <div className="flex items-start gap-4">
                <div className="shrink-0">
                  <CompanyPatternIcon
                    companyName={companyName || selectedCompany.name}
                    brandColor={brandColor || null}
                    className="rounded-[14px]"
                  />
                </div>
                <div className="flex-1 space-y-2">
                  <Field label="Brand color" hint="Sets the hue for the company icon. Leave empty for auto-generated color.">
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={brandColor || "#6366f1"}
                        onChange={(e) => setBrandColor(e.target.value)}
                        className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                      />
                      <input
                        type="text"
                        value={brandColor}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                            setBrandColor(v);
                          }
                        }}
                        placeholder="Auto"
                        className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                      />
                      {brandColor && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setBrandColor("")}
                          className="text-xs text-muted-foreground"
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                  </Field>
                </div>
              </div>
            </div>
          </div>

          {generalDirty && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleSaveGeneral}
                disabled={generalMutation.isPending || !companyName.trim()}
              >
                {generalMutation.isPending ? "Saving..." : "Save changes"}
              </Button>
              {generalMutation.isSuccess && (
                <span className="text-xs text-muted-foreground">Saved</span>
              )}
              {generalMutation.isError && (
                <span className="text-xs text-destructive">
                  {generalMutation.error instanceof Error
                    ? generalMutation.error.message
                    : "Failed to save"}
                </span>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Hiring
            </div>
            <div className="rounded-md border border-border px-4 py-3">
              <ToggleField
                label="Require board approval for new hires"
                hint="New agent hires stay pending until approved by board."
                checked={!!selectedCompany.requireBoardApprovalForNewAgents}
                onChange={(v) => settingsMutation.mutate(v)}
              />
            </div>
          </div>

          <div className="space-y-4">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Invites
            </div>
            <div className="space-y-3 rounded-md border border-border px-4 py-4">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Generate a link to invite humans or agents to this company.</span>
                <HintIcon text="Invite links expire after 72 hours and allow both human and agent joins." />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => inviteMutation.mutate()} disabled={inviteMutation.isPending}>
                  {inviteMutation.isPending ? "Creating..." : "Create invite link"}
                </Button>
                {inviteLink && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await navigator.clipboard.writeText(inviteLink);
                    }}
                  >
                    Copy link
                  </Button>
                )}
              </div>
              {inviteError && <p className="text-sm text-destructive">{inviteError}</p>}
              {inviteLink && (
                <div className="rounded-md border border-border bg-muted/30 p-2">
                  <div className="text-xs text-muted-foreground">Share link</div>
                  <div className="mt-1 break-all font-mono text-xs">{inviteLink}</div>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="text-xs font-medium text-amber-700 uppercase tracking-wide">
              Archive
            </div>
            <div className="space-y-3 rounded-md border border-amber-300/60 bg-amber-100/30 px-4 py-4">
              <p className="text-sm text-muted-foreground">
                Archive this company to hide it from the sidebar. This persists in the database.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={archiveMutation.isPending || selectedCompany.status === "archived"}
                  onClick={() => {
                    if (!selectedCompanyId) return;
                    const confirmed = window.confirm(
                      `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`,
                    );
                    if (!confirmed) return;
                    const nextCompanyId = companies.find((company) =>
                      company.id !== selectedCompanyId && company.status !== "archived")?.id ?? null;
                    archiveMutation.mutate({ companyId: selectedCompanyId, nextCompanyId });
                  }}
                >
                  {archiveMutation.isPending
                    ? "Archiving..."
                    : selectedCompany.status === "archived"
                      ? "Already archived"
                      : "Archive company"}
                </Button>
                {archiveMutation.isError && (
                  <span className="text-xs text-destructive">
                    {archiveMutation.error instanceof Error
                      ? archiveMutation.error.message
                      : "Failed to archive company"}
                  </span>
                )}
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="remote" className="space-y-6 max-w-4xl">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <ServerCog className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Remote Execution Targets
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add SSH-reachable machines that agents can use when an issue is marked remote.
                </p>
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-border px-4 py-4">
              <div className="flex items-center gap-2">
                <Plus className="h-4 w-4 text-muted-foreground" />
                <div className="text-sm font-medium">Add target</div>
              </div>
              <RemoteTargetForm
                draft={newRemoteTarget}
                onChange={setNewRemoteTarget}
                disabled={remoteTargetsMutation.isPending}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    testRemoteTargetMutation.mutate({
                      targetId: null,
                      payload: normalizeRemoteTargetTestPayload(newRemoteTarget),
                    })
                  }
                  disabled={
                    testRemoteTargetMutation.isPending ||
                    !newRemoteTarget.host.trim() ||
                    !newRemoteTarget.workerPath.trim()
                  }
                >
                  {testRemoteTargetMutation.isPending ? "Testing..." : "Test"}
                </Button>
                <Button
                  size="sm"
                  onClick={handleCreateRemoteTarget}
                  disabled={
                    remoteTargetsMutation.isPending ||
                    !newRemoteTarget.name.trim() ||
                    !newRemoteTarget.host.trim() ||
                    newRemoteTarget.supportedAdapters.length === 0
                  }
                >
                  {remoteTargetsMutation.isPending ? "Adding..." : "Add target"}
                </Button>
                {remoteTargetsMutation.isError && (
                  <span className="text-xs text-destructive">
                    {remoteTargetsMutation.error instanceof Error
                      ? remoteTargetsMutation.error.message
                      : "Failed to add target"}
                  </span>
                )}
                {testRemoteTargetMutation.isError && !newRemoteTargetTestResult && (
                  <span className="text-xs text-destructive">
                    {testRemoteTargetMutation.error instanceof Error
                      ? testRemoteTargetMutation.error.message
                      : "Failed to test target"}
                  </span>
                )}
              </div>
              {renderRemoteTargetTestResult(newRemoteTargetTestResult)}
            </div>
          </div>

          <div className="space-y-4">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Existing targets
            </div>

            {remoteTargetsLoading ? (
              <div className="rounded-md border border-border px-4 py-4 text-sm text-muted-foreground">
                Loading remote targets...
              </div>
            ) : !remoteTargets || remoteTargets.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                No remote execution targets yet.
              </div>
            ) : (
              <div className="space-y-3">
                {remoteTargets.map((target) => {
                  const draft = editingTargets[target.id] ?? buildRemoteTargetDraft(target);
                  const dirty =
                    JSON.stringify(normalizeRemoteTargetPayload(draft)) !==
                    JSON.stringify(normalizeRemoteTargetPayload(buildRemoteTargetDraft(target)));

                  return (
                    <div key={target.id} className="space-y-3 rounded-md border border-border px-4 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium">{target.name}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {target.user}@{target.host}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              testRemoteTargetMutation.mutate({
                                targetId: target.id,
                                payload: normalizeRemoteTargetTestPayload(draft),
                              })
                            }
                            disabled={
                              testRemoteTargetMutation.isPending ||
                              !draft.host.trim() ||
                              !draft.workerPath.trim()
                            }
                          >
                            {testRemoteTargetMutation.isPending ? "Testing..." : "Test"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setEditingTargets((current) => ({
                                ...current,
                                [target.id]: buildRemoteTargetDraft(target),
                              }))
                            }
                            disabled={!dirty || updateRemoteTargetMutation.isPending}
                          >
                            Reset
                          </Button>
                          <Button
                            size="sm"
                            onClick={() =>
                              updateRemoteTargetMutation.mutate({
                                targetId: target.id,
                                payload: normalizeRemoteTargetPayload(draft),
                              })
                            }
                            disabled={
                              updateRemoteTargetMutation.isPending ||
                              !draft.name.trim() ||
                              !draft.host.trim() ||
                              draft.supportedAdapters.length === 0
                            }
                          >
                            <Save className="mr-1 h-3.5 w-3.5" />
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const confirmed = window.confirm(`Archive remote target "${target.name}"?`);
                              if (!confirmed) return;
                              archiveRemoteTargetMutation.mutate(target.id);
                            }}
                            disabled={archiveRemoteTargetMutation.isPending}
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" />
                            Archive
                          </Button>
                        </div>
                      </div>

                      <RemoteTargetForm
                        draft={draft}
                        onChange={(next) =>
                          setEditingTargets((current) => ({
                            ...current,
                            [target.id]: next,
                          }))
                        }
                        disabled={updateRemoteTargetMutation.isPending || archiveRemoteTargetMutation.isPending}
                      />
                      {renderRemoteTargetTestResult(editingTargetTestResults[target.id] ?? null)}
                    </div>
                  );
                })}
              </div>
            )}

            {(updateRemoteTargetMutation.isError || archiveRemoteTargetMutation.isError) && (
              <div className="text-xs text-destructive">
                {(updateRemoteTargetMutation.error instanceof Error
                  ? updateRemoteTargetMutation.error.message
                  : archiveRemoteTargetMutation.error instanceof Error
                    ? archiveRemoteTargetMutation.error.message
                    : "Failed to update remote targets")}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="org" className="space-y-4">
          <OrgChart embedded />
        </TabsContent>

        <TabsContent value="costs" className="space-y-4 max-w-5xl">
          <Costs embedded />
        </TabsContent>

        <TabsContent value="activity" className="space-y-4 max-w-5xl">
          <Activity embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}
