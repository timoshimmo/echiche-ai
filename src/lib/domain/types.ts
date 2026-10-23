export type Project = {
  id: string;
  title: string;
  problemStatement: string;
  createdAt: string;
};

export type RunStatus = "queued" | "running" | "succeeded" | "failed";
export type RunEventType = "status" | "stage" | "result" | "error";

export type RunEvent = {
  id: string;
  runId: string;
  type: RunEventType;
  stage: string;
  message: string;
  createdAt: string;
};

export type ThoughtRun = {
  id: string;
  projectId: string;
  prompt: string;
  status: RunStatus;
  result: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type CreateProjectInput = {
  title: string;
  problemStatement: string;
};

export type StartRunInput = {
  prompt: string;
};
