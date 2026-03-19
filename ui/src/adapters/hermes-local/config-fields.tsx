import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the Hermes prompt at runtime.";

export function HermesLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Agent instructions file" hint={instructionsFileHint}>
        <div className="flex items-center gap-2">
          <DraftInput
            value={
              isCreate
                ? values!.instructionsFilePath ?? ""
                : eff(
                    "adapterConfig",
                    "instructionsFilePath",
                    String(config.instructionsFilePath ?? ""),
                  )
            }
            onCommit={(v) =>
              isCreate
                ? set!({ instructionsFilePath: v })
                : mark("adapterConfig", "instructionsFilePath", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="/absolute/path/to/AGENTS.md"
          />
          <ChoosePathButton />
        </div>
      </Field>
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}

export function HermesLocalAdvancedFields({
  isCreate,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  if (isCreate) return null;
  return (
    <>
      <ToggleField
        label="Persist sessions"
        hint="Resume Hermes sessions across heartbeat runs. When enabled, context carries over between runs."
        checked={eff("adapterConfig", "persistSession", config.persistSession !== false)}
        onChange={(v) => mark("adapterConfig", "persistSession", v)}
      />
      <Field label="Toolsets" hint="Comma-separated list of toolsets to enable (e.g. terminal,file,web,browser,vision,git). Leave empty for all.">
        <DraftInput
          value={eff("adapterConfig", "toolsets", String(config.toolsets ?? ""))}
          onCommit={(v) => mark("adapterConfig", "toolsets", v || undefined)}
          immediate
          className={inputClass}
          placeholder="terminal,file,web"
        />
      </Field>
      <Field label="Hermes command" hint="Path to hermes CLI binary. Defaults to 'hermes'.">
        <DraftInput
          value={eff("adapterConfig", "hermesCommand", String(config.hermesCommand ?? ""))}
          onCommit={(v) => mark("adapterConfig", "hermesCommand", v || undefined)}
          immediate
          className={inputClass}
          placeholder="hermes"
        />
      </Field>
    </>
  );
}
