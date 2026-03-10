import type {
  CreateRemoteExecutionTarget,
  RemoteExecutionTarget,
  TestRemoteExecutionTarget,
  UpdateRemoteExecutionTarget,
} from "@paperclipai/shared";
import { api } from "./client";

export type RemoteExecutionTargetTestResult = {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  errorMessage: string | null;
};

export const remoteExecutionApi = {
  listTargets: (companyId: string) =>
    api.get<RemoteExecutionTarget[]>(`/companies/${companyId}/remote-execution-targets`),
  testTarget: (companyId: string, data: TestRemoteExecutionTarget) =>
    api.post<RemoteExecutionTargetTestResult>(`/companies/${companyId}/remote-execution-targets/test`, data),
  createTarget: (companyId: string, data: CreateRemoteExecutionTarget) =>
    api.post<RemoteExecutionTarget>(`/companies/${companyId}/remote-execution-targets`, data),
  updateTarget: (targetId: string, data: UpdateRemoteExecutionTarget) =>
    api.patch<RemoteExecutionTarget>(`/remote-execution-targets/${targetId}`, data),
  archiveTarget: (targetId: string) =>
    api.delete<RemoteExecutionTarget>(`/remote-execution-targets/${targetId}`),
};
