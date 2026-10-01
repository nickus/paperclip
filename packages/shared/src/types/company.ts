import type {
  CompanyStatus,
  IssueThreadInteractionKind,
  IssueThreadInteractionResolverPolicy,
  PauseReason,
} from "../constants.js";
import type { SharedWorkspaceConcurrency } from "./workspace-runtime.js";

export interface InteractionResolverKindGovernance {
  defaultPolicy?: IssueThreadInteractionResolverPolicy;
  cap?: IssueThreadInteractionResolverPolicy;
}

export type InteractionResolverGovernance = Partial<
  Record<IssueThreadInteractionKind, InteractionResolverKindGovernance>
>;

/**
 * Company-wide defaults for execution workspaces. Each value applies to every
 * project in the company that does not set its own value in an enabled
 * execution workspace policy; issue execution workspace settings still win.
 */
export interface CompanyExecutionWorkspaceDefaults {
  sharedWorkspaceConcurrency?: SharedWorkspaceConcurrency;
}

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  defaultResponsibleUserId: string | null;
  requireBoardApprovalForNewAgents: boolean;
  interactionResolverGovernance: InteractionResolverGovernance;
  executionWorkspaceDefaults: CompanyExecutionWorkspaceDefaults;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
