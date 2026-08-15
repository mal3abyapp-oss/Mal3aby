// Auto-generated from the live Supabase project schema (gxkrtlvpjwxhcqdisyob).
// Regenerate whenever supabase/migrations/ changes:
//   Supabase MCP generate_typescript_types, or `supabase gen types typescript`.
// Do not hand-edit.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          after: Json | null
          before: Json | null
          branch_id: string | null
          club_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          reason: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          after?: Json | null
          before?: Json | null
          branch_id?: string | null
          club_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          reason?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          after?: Json | null
          before?: Json | null
          branch_id?: string | null
          club_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      automatic_trial_entitlements: {
        Row: {
          club_id: string
          consumed_at: string
          id: string
          owner_email_snapshot: string | null
          owner_normalized_mobile_snapshot: string | null
          user_id: string
        }
        Insert: {
          club_id: string
          consumed_at?: string
          id?: string
          owner_email_snapshot?: string | null
          owner_normalized_mobile_snapshot?: string | null
          user_id: string
        }
        Update: {
          club_id?: string
          consumed_at?: string
          id?: string
          owner_email_snapshot?: string | null
          owner_normalized_mobile_snapshot?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automatic_trial_entitlements_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          address: string | null
          branch_code: string
          club_id: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          opening_hours: Json | null
          phone: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          branch_code: string
          club_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          opening_hours?: Json | null
          phone?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          branch_code?: string
          club_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          opening_hours?: Json | null
          phone?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "branches_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      club_memberships: {
        Row: {
          club_id: string
          created_at: string
          id: string
          role_id: string
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          club_id: string
          created_at?: string
          id?: string
          role_id: string
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          club_id?: string
          created_at?: string
          id?: string
          role_id?: string
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_memberships_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_memberships_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      clubs: {
        Row: {
          club_code: string
          created_at: string
          created_by: string | null
          currency: string
          id: string
          invoice_settings: Json | null
          logo_url: string | null
          name: string
          name_ar: string
          name_en: string | null
          status: string
          subscription_activation_policy: string
          tax_info: Json | null
          timezone: string
          updated_at: string | null
        }
        Insert: {
          club_code: string
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          invoice_settings?: Json | null
          logo_url?: string | null
          name: string
          name_ar: string
          name_en?: string | null
          status?: string
          subscription_activation_policy?: string
          tax_info?: Json | null
          timezone?: string
          updated_at?: string | null
        }
        Update: {
          club_code?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          invoice_settings?: Json | null
          logo_url?: string | null
          name?: string
          name_ar?: string
          name_en?: string | null
          status?: string
          subscription_activation_policy?: string
          tax_info?: Json | null
          timezone?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      contact_requests: {
        Row: {
          business_name: string | null
          created_at: string
          email: string | null
          id: string
          message: string | null
          name: string
          phone: string
          status: string
          updated_at: string | null
        }
        Insert: {
          business_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          message?: string | null
          name: string
          phone: string
          status?: string
          updated_at?: string | null
        }
        Update: {
          business_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          message?: string | null
          name?: string
          phone?: string
          status?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      membership_branches: {
        Row: {
          branch_id: string
          id: string
          membership_id: string
        }
        Insert: {
          branch_id: string
          id?: string
          membership_id: string
        }
        Update: {
          branch_id?: string
          id?: string
          membership_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "membership_branches_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_branches_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "club_memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      permissions: {
        Row: {
          description: string | null
          id: string
          key: string
        }
        Insert: {
          description?: string | null
          id?: string
          key: string
        }
        Update: {
          description?: string | null
          id?: string
          key?: string
        }
        Relationships: []
      }
      platform_invoices: {
        Row: {
          amount: number
          club_id: string
          created_at: string
          due_date: string
          id: string
          invoice_number: number
          platform_subscription_id: string
          status: string
          updated_at: string | null
        }
        Insert: {
          amount: number
          club_id: string
          created_at?: string
          due_date: string
          id?: string
          invoice_number?: number
          platform_subscription_id: string
          status?: string
          updated_at?: string | null
        }
        Update: {
          amount?: number
          club_id?: string
          created_at?: string
          due_date?: string
          id?: string
          invoice_number?: number
          platform_subscription_id?: string
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_invoices_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_invoices_platform_subscription_id_fkey"
            columns: ["platform_subscription_id"]
            isOneToOne: false
            referencedRelation: "platform_subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_payments: {
        Row: {
          amount: number
          id: string
          method: string
          platform_invoice_id: string
          recorded_at: string
          recorded_by: string | null
          reference: string | null
          reversal_reason: string | null
          reversed_at: string | null
          reversed_by: string | null
        }
        Insert: {
          amount: number
          id?: string
          method: string
          platform_invoice_id: string
          recorded_at?: string
          recorded_by?: string | null
          reference?: string | null
          reversal_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
        }
        Update: {
          amount?: number
          id?: string
          method?: string
          platform_invoice_id?: string
          recorded_at?: string
          recorded_by?: string | null
          reference?: string | null
          reversal_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_payments_platform_invoice_id_fkey"
            columns: ["platform_invoice_id"]
            isOneToOne: false
            referencedRelation: "platform_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_plans: {
        Row: {
          billing_interval: string
          billing_interval_count: number
          created_at: string
          currency: string
          default_grace_period_days: number
          description_ar: string | null
          discount_label: string | null
          display_order: number
          features_summary: string | null
          id: string
          is_public: boolean
          name: string
          name_ar: string
          price: number
          status: string
          updated_at: string | null
        }
        Insert: {
          billing_interval: string
          billing_interval_count: number
          created_at?: string
          currency?: string
          default_grace_period_days?: number
          description_ar?: string | null
          discount_label?: string | null
          display_order?: number
          features_summary?: string | null
          id?: string
          is_public?: boolean
          name: string
          name_ar: string
          price: number
          status?: string
          updated_at?: string | null
        }
        Update: {
          billing_interval?: string
          billing_interval_count?: number
          created_at?: string
          currency?: string
          default_grace_period_days?: number
          description_ar?: string | null
          discount_label?: string | null
          display_order?: number
          features_summary?: string | null
          id?: string
          is_public?: boolean
          name?: string
          name_ar?: string
          price?: number
          status?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      platform_settings: {
        Row: {
          default_grace_period_days: number
          default_trial_days: number
          id: boolean
          updated_at: string | null
        }
        Insert: {
          default_grace_period_days?: number
          default_trial_days?: number
          id?: boolean
          updated_at?: string | null
        }
        Update: {
          default_grace_period_days?: number
          default_trial_days?: number
          id?: boolean
          updated_at?: string | null
        }
        Relationships: []
      }
      platform_subscriptions: {
        Row: {
          cancelled_at: string | null
          cancelled_by: string | null
          cancelled_reason: string | null
          club_id: string
          created_at: string
          currency_snapshot: string | null
          during: unknown
          end_at: string
          grace_period_days_snapshot: number
          id: string
          interval_count_snapshot: number | null
          interval_snapshot: string | null
          lifecycle_status: string
          plan_id: string | null
          plan_name_snapshot: string | null
          previous_subscription_id: string | null
          price_snapshot: number
          start_at: string
          subscription_kind: string
          trial_origin: string | null
          updated_at: string | null
        }
        Insert: {
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancelled_reason?: string | null
          club_id: string
          created_at?: string
          currency_snapshot?: string | null
          during?: unknown
          end_at: string
          grace_period_days_snapshot?: number
          id?: string
          interval_count_snapshot?: number | null
          interval_snapshot?: string | null
          lifecycle_status: string
          plan_id?: string | null
          plan_name_snapshot?: string | null
          previous_subscription_id?: string | null
          price_snapshot?: number
          start_at: string
          subscription_kind: string
          trial_origin?: string | null
          updated_at?: string | null
        }
        Update: {
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancelled_reason?: string | null
          club_id?: string
          created_at?: string
          currency_snapshot?: string | null
          during?: unknown
          end_at?: string
          grace_period_days_snapshot?: number
          id?: string
          interval_count_snapshot?: number | null
          interval_snapshot?: string | null
          lifecycle_status?: string
          plan_id?: string | null
          plan_name_snapshot?: string | null
          previous_subscription_id?: string | null
          price_snapshot?: number
          start_at?: string
          subscription_kind?: string
          trial_origin?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_subscriptions_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "platform_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_subscriptions_previous_subscription_id_fkey"
            columns: ["previous_subscription_id"]
            isOneToOne: false
            referencedRelation: "platform_subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          permission_id: string
          role_id: string
        }
        Insert: {
          permission_id: string
          role_id: string
        }
        Update: {
          permission_id?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          id: string
          key: string
          name: string
          name_ar: string
        }
        Insert: {
          id?: string
          key: string
          name: string
          name_ar: string
        }
        Update: {
          id?: string
          key?: string
          name?: string
          name_ar?: string
        }
        Relationships: []
      }
    }
    Views: {
      club_platform_subscription_summary: {
        Row: {
          club_id: string | null
          effective_access: string | null
          end_at: string | null
          lifecycle_status: string | null
          plan_name_snapshot: string | null
          start_at: string | null
          subscription_kind: string | null
        }
        Insert: {
          club_id?: string | null
          effective_access?: never
          end_at?: string | null
          lifecycle_status?: string | null
          plan_name_snapshot?: string | null
          start_at?: string | null
          subscription_kind?: string | null
        }
        Update: {
          club_id?: string | null
          effective_access?: never
          end_at?: string | null
          lifecycle_status?: string | null
          plan_name_snapshot?: string | null
          start_at?: string | null
          subscription_kind?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_subscriptions_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      public_plans: {
        Row: {
          billing_interval: string | null
          billing_interval_count: number | null
          currency: string | null
          description_ar: string | null
          discount_label: string | null
          features_summary: string | null
          name_ar: string | null
          price: number | null
        }
        Insert: {
          billing_interval?: string | null
          billing_interval_count?: number | null
          currency?: string | null
          description_ar?: string | null
          discount_label?: string | null
          features_summary?: string | null
          name_ar?: string | null
          price?: number | null
        }
        Update: {
          billing_interval?: string | null
          billing_interval_count?: number | null
          currency?: string | null
          description_ar?: string | null
          discount_label?: string | null
          features_summary?: string | null
          name_ar?: string | null
          price?: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      cancel_platform_subscription: {
        Args: { p_reason: string; p_subscription_id: string }
        Returns: undefined
      }
      change_platform_plan: {
        Args: {
          p_current_subscription_id: string
          p_new_plan_id: string
          p_reason?: string
        }
        Returns: string
      }
      club_write_allowed: {
        Args: { p_action_category: string; p_club_id: string }
        Returns: boolean
      }
      create_platform_subscription: {
        Args: {
          p_club_id: string
          p_plan_id?: string
          p_subscription_kind: string
          p_trial_origin?: string
        }
        Returns: string
      }
      deactivate_staff_member: {
        Args: { p_membership_id: string }
        Returns: undefined
      }
      extend_grace_period: {
        Args: { p_grace_period_days: number; p_subscription_id: string }
        Returns: undefined
      }
      get_club_platform_access: { Args: { p_club_id: string }; Returns: string }
      has_branch_access: {
        Args: { p_branch_id: string; p_membership_id: string }
        Returns: boolean
      }
      has_permission: {
        Args: { p_club_id: string; p_key: string }
        Returns: boolean
      }
      invite_staff_member: {
        Args: {
          p_branch_ids?: string[]
          p_club_id: string
          p_email: string
          p_role_key: string
        }
        Returns: string
      }
      is_platform_owner: { Args: Record<PropertyKey, never>; Returns: boolean }
      record_platform_payment: {
        Args: {
          p_amount: number
          p_invoice_id: string
          p_method: string
          p_reference?: string
        }
        Returns: string
      }
      renew_platform_subscription: {
        Args: { p_plan_id?: string; p_previous_subscription_id: string }
        Returns: string
      }
      reverse_platform_payment: {
        Args: { p_payment_id: string; p_reason: string }
        Returns: undefined
      }
      set_plan_publish_status: {
        Args: { p_is_public: boolean; p_plan_id: string }
        Returns: undefined
      }
      user_club_ids: { Args: Record<PropertyKey, never>; Returns: string[] }
      write_audit_log: {
        Args: {
          p_action: string
          p_after: Json
          p_before: Json
          p_club_id: string
          p_entity_id: string
          p_entity_type: string
          p_reason: string
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
