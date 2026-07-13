import type { SkillInfo, SkillProposal } from "./model";

export type SkillView = {
  name: string;
  file_path: string;
  skill_dir?: string;
  supporting_files: string[];
  view_count: number;
  last_viewed_at: string;
  content: string;
};

export interface SkillsService {
  viewSkill(skillName: string, filePath?: string): Promise<SkillView>;
  manageSkill(
    params: Record<string, unknown>,
    approved?: boolean,
  ): Promise<Record<string, unknown>>;
  activateSkillProposal(proposalId: string, approved?: boolean): Promise<SkillProposal>;
  getSkillProposal(proposalId: string): Promise<SkillProposal | undefined>;
  listSkills(): Promise<SkillInfo[]>;
}
