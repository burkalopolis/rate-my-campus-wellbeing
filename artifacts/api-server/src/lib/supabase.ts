import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";

export type Campus = {
  id: string;
  slug: string;
  name: string;
  system: "UC" | "CSU" | "Other";
  city: string | null;
  active: boolean;
  created_at: string;
};

export type Submitter = {
  id: string;
  community_tags: string[];
  archetype_self: "guardian" | "warrior" | "healer" | "guide" | null;
  student_type: "undergraduate" | "graduate" | "unknown";
  session_hash: string | null;
  created_at: string;
};

export type Submission = {
  id: string;
  campus_id: string;
  submitter_id: string;
  subject_tag: "campus-overall" | "department-major" | "facility" | "program" | "resource" | "transition-experience";
  dimension_tag: "physical" | "emotional" | "intellectual" | "social" | "spiritual" | "environmental" | "occupational" | "financial";
  archetype_derived: "guardian" | "warrior" | "healer" | "guide" | null;
  prompt_mode: "free" | "prompted";
  prompt_used: string | null;
  feedback_text: string;
  year_in_school: "1st" | "2nd" | "3rd" | "4th" | "grad" | null;
  major: string | null;
  approved: boolean;
  flagged: boolean;
  flag_reason: string | null;
  created_at: string;
  approved_at: string | null;
};

export type CampusScore = {
  id: string;
  campus_id: string;
  dimension_tag: string;
  archetype_tag: string;
  submission_count: number;
  avg_score: number | null;
  pct_of_total: number | null;
  last_refreshed_at: string;
};

export type ArchetypeScore = {
  id: string;
  campus_id: string;
  archetype_tag: "guardian" | "warrior" | "healer" | "guide";
  submission_count: number;
  pct_of_total: number | null;
  is_dominant: boolean;
  last_refreshed_at: string;
};

export type Database = {
  public: {
    Tables: {
      campuses: { Row: Campus; Insert: Omit<Campus, "id" | "created_at">; Update: Partial<Campus> };
      submitters: { Row: Submitter; Insert: Omit<Submitter, "id" | "created_at">; Update: Partial<Submitter> };
      submissions: { Row: Submission; Insert: Omit<Submission, "id" | "created_at" | "archetype_derived">; Update: Partial<Submission> };
      campus_scores: { Row: CampusScore; Insert: Omit<CampusScore, "id">; Update: Partial<CampusScore> };
      archetype_scores: { Row: ArchetypeScore; Insert: Omit<ArchetypeScore, "id">; Update: Partial<ArchetypeScore> };
    };
  };
};

let supabase: SupabaseClient<Database>;

try {
  supabase = createClient<Database>(supabaseUrl, supabaseAnonKey);
  logger.info("Supabase client initialized");
} catch (err) {
  logger.error({ err }, "Supabase client failed to initialize — check SUPABASE_URL and SUPABASE_ANON_KEY");
  supabase = {} as SupabaseClient<Database>;
}

export { supabase };
