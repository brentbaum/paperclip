export interface AgentFileEntry {
  path: string;
  name: string;
  relativePath: string;
  rootLabel: string;
  isInstructionsFile: boolean;
  sizeBytes: number;
  updatedAt: Date;
}

export interface AgentFileContent {
  path: string;
  name: string;
  relativePath: string;
  rootLabel: string;
  isInstructionsFile: boolean;
  body: string;
  sizeBytes: number;
  updatedAt: Date;
}
