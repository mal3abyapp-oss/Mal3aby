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
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      age_groups: {
        Row: {
          club_id: string
          created_at: string
          created_by: string | null
          id: string
          max_age: number | null
          min_age: number | null
          name: string
        }
        Insert: {
          club_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          max_age?: number | null
          min_age?: number | null
          name: string
        }
        Update: {
          club_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          max_age?: number | null
          min_age?: number | null
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "age_groups_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance: {
        Row: {
          club_id: string
          id: string
          marked_at: string
          marked_by: string | null
          method: string
          player_id: string
          session_id: string
          status: string
        }
        Insert: {
          club_id: string
          id?: string
          marked_at?: string
          marked_by?: string | null
          method?: string
          player_id: string
          session_id: string
          status: string
        }
        Update: {
          club_id?: string
          id?: string
          marked_at?: string
          marked_by?: string | null
          method?: string
          player_id?: string
          session_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "training_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
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
      booking_series: {
        Row: {
          club_id: string
          created_at: string
          created_by: string | null
          created_occurrences: number
          customer_id: string
          field_id: string
          id: string
          pattern_description: string | null
          requested_occurrences: number
        }
        Insert: {
          club_id: string
          created_at?: string
          created_by?: string | null
          created_occurrences?: number
          customer_id: string
          field_id: string
          id?: string
          pattern_description?: string | null
          requested_occurrences: number
        }
        Update: {
          club_id?: string
          created_at?: string
          created_by?: string | null
          created_occurrences?: number
          customer_id?: string
          field_id?: string
          id?: string
          pattern_description?: string | null
          requested_occurrences?: number
        }
        Relationships: [
          {
            foreignKeyName: "booking_series_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_series_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_series_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          booking_series_id: string | null
          branch_id: string
          cancelled_at: string | null
          cancelled_by: string | null
          cancelled_reason: string | null
          club_id: string
          created_at: string
          created_by: string | null
          customer_id: string
          discount_amount: number
          during: unknown
          end_at: string
          field_id: string
          id: string
          invoice_id: string | null
          marked_at: string | null
          marked_by: string | null
          notes: string | null
          start_at: string
          status: string
          total_price: number
          updated_at: string | null
        }
        Insert: {
          booking_series_id?: string | null
          branch_id: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancelled_reason?: string | null
          club_id: string
          created_at?: string
          created_by?: string | null
          customer_id: string
          discount_amount?: number
          during?: unknown
          end_at: string
          field_id: string
          id?: string
          invoice_id?: string | null
          marked_at?: string | null
          marked_by?: string | null
          notes?: string | null
          start_at: string
          status?: string
          total_price: number
          updated_at?: string | null
        }
        Update: {
          booking_series_id?: string | null
          branch_id?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancelled_reason?: string | null
          club_id?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string
          discount_amount?: number
          during?: unknown
          end_at?: string
          field_id?: string
          id?: string
          invoice_id?: string | null
          marked_at?: string | null
          marked_by?: string | null
          notes?: string | null
          start_at?: string
          status?: string
          total_price?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bookings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "outstanding_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_series_fkey"
            columns: ["booking_series_id"]
            isOneToOne: false
            referencedRelation: "booking_series"
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
          flagged_duplicate: boolean
          flagged_duplicate_reason: string | null
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
          flagged_duplicate?: boolean
          flagged_duplicate_reason?: string | null
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
          flagged_duplicate?: boolean
          flagged_duplicate_reason?: string | null
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
      customers: {
        Row: {
          address: string | null
          club_id: string
          created_at: string
          created_by: string | null
          date_of_birth: string | null
          email: string | null
          emergency_contact: Json | null
          full_name: string
          gender: string | null
          id: string
          mobile_display: string | null
          national_id: string | null
          normalized_mobile: string | null
          notes: string | null
          photo_url: string | null
          updated_at: string | null
          whatsapp: string | null
        }
        Insert: {
          address?: string | null
          club_id: string
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          email?: string | null
          emergency_contact?: Json | null
          full_name: string
          gender?: string | null
          id?: string
          mobile_display?: string | null
          national_id?: string | null
          normalized_mobile?: string | null
          notes?: string | null
          photo_url?: string | null
          updated_at?: string | null
          whatsapp?: string | null
        }
        Update: {
          address?: string | null
          club_id?: string
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          email?: string | null
          emergency_contact?: Json | null
          full_name?: string
          gender?: string | null
          id?: string
          mobile_display?: string | null
          national_id?: string | null
          normalized_mobile?: string | null
          notes?: string | null
          photo_url?: string | null
          updated_at?: string | null
          whatsapp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      enrollments: {
        Row: {
          club_id: string
          created_by: string | null
          enrolled_at: string
          group_id: string
          guardian_id: string | null
          id: string
          player_id: string
          status: string
        }
        Insert: {
          club_id: string
          created_by?: string | null
          enrolled_at?: string
          group_id: string
          guardian_id?: string | null
          id?: string
          player_id: string
          status?: string
        }
        Update: {
          club_id?: string
          created_by?: string | null
          enrolled_at?: string
          group_id?: string
          guardian_id?: string | null
          id?: string
          player_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "enrollments_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollments_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollments_guardian_id_fkey"
            columns: ["guardian_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollments_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollments_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      field_blocks: {
        Row: {
          club_id: string
          created_at: string
          created_by: string | null
          end_at: string
          field_id: string
          id: string
          reason: string | null
          start_at: string
          type: string
        }
        Insert: {
          club_id: string
          created_at?: string
          created_by?: string | null
          end_at: string
          field_id: string
          id?: string
          reason?: string | null
          start_at: string
          type: string
        }
        Update: {
          club_id?: string
          created_at?: string
          created_by?: string | null
          end_at?: string
          field_id?: string
          id?: string
          reason?: string | null
          start_at?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "field_blocks_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_blocks_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      field_operating_hours: {
        Row: {
          branch_id: string | null
          close_time: string
          club_id: string
          created_at: string
          day_of_week: number
          field_id: string | null
          id: string
          open_time: string
        }
        Insert: {
          branch_id?: string | null
          close_time: string
          club_id: string
          created_at?: string
          day_of_week: number
          field_id?: string | null
          id?: string
          open_time: string
        }
        Update: {
          branch_id?: string | null
          close_time?: string
          club_id?: string
          created_at?: string
          day_of_week?: number
          field_id?: string | null
          id?: string
          open_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "field_operating_hours_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_operating_hours_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_operating_hours_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      fields: {
        Row: {
          branch_id: string
          capacity: number | null
          club_id: string
          created_at: string
          created_by: string | null
          default_duration_minutes: number
          id: string
          images: Json | null
          indoor: boolean
          maintenance_status: string | null
          name: string
          notes: string | null
          sport: string
          status: string
          updated_at: string | null
        }
        Insert: {
          branch_id: string
          capacity?: number | null
          club_id: string
          created_at?: string
          created_by?: string | null
          default_duration_minutes?: number
          id?: string
          images?: Json | null
          indoor?: boolean
          maintenance_status?: string | null
          name: string
          notes?: string | null
          sport: string
          status?: string
          updated_at?: string | null
        }
        Update: {
          branch_id?: string
          capacity?: number | null
          club_id?: string
          created_at?: string
          created_by?: string | null
          default_duration_minutes?: number
          id?: string
          images?: Json | null
          indoor?: boolean
          maintenance_status?: string | null
          name?: string
          notes?: string | null
          sport?: string
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fields_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fields_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      group_schedule_slots: {
        Row: {
          created_at: string
          day_of_week: number
          end_time: string
          group_id: string
          id: string
          start_time: string
        }
        Insert: {
          created_at?: string
          day_of_week: number
          end_time: string
          group_id: string
          id?: string
          start_time: string
        }
        Update: {
          created_at?: string
          day_of_week?: number
          end_time?: string
          group_id?: string
          id?: string
          start_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_schedule_slots_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          age_group_id: string | null
          assistant_coach_id: string | null
          branch_id: string
          capacity: number
          club_id: string
          coach_id: string | null
          created_at: string
          created_by: string | null
          field_id: string | null
          id: string
          name: string
          program_id: string
          season_id: string
          status: string
          updated_at: string
        }
        Insert: {
          age_group_id?: string | null
          assistant_coach_id?: string | null
          branch_id: string
          capacity: number
          club_id: string
          coach_id?: string | null
          created_at?: string
          created_by?: string | null
          field_id?: string | null
          id?: string
          name: string
          program_id: string
          season_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          age_group_id?: string | null
          assistant_coach_id?: string | null
          branch_id?: string
          capacity?: number
          club_id?: string
          coach_id?: string | null
          created_at?: string
          created_by?: string | null
          field_id?: string | null
          id?: string
          name?: string
          program_id?: string
          season_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "groups_age_group_id_fkey"
            columns: ["age_group_id"]
            isOneToOne: false
            referencedRelation: "age_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "groups_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "groups_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "groups_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "groups_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "groups_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      guardian_links: {
        Row: {
          created_at: string
          customer_id: string
          id: string
          is_primary: boolean
          player_id: string
          relationship: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          id?: string
          is_primary?: boolean
          player_id: string
          relationship: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          id?: string
          is_primary?: boolean
          player_id?: string
          relationship?: string
        }
        Relationships: [
          {
            foreignKeyName: "guardian_links_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guardian_links_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guardian_links_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_items: {
        Row: {
          created_at: string
          description: string
          id: string
          invoice_id: string
          line_total: number
          quantity: number
          reference_id: string | null
          reference_type: string
          unit_price: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          line_total: number
          quantity?: number
          reference_id?: string | null
          reference_type: string
          unit_price: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          line_total?: number
          quantity?: number
          reference_id?: string | null
          reference_type?: string
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "outstanding_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_number_sequences: {
        Row: {
          branch_id: string
          id: string
          last_number: number
          year: number
        }
        Insert: {
          branch_id: string
          id?: string
          last_number?: number
          year: number
        }
        Update: {
          branch_id?: string
          id?: string
          last_number?: number
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_number_sequences_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          branch_id: string
          club_id: string
          created_at: string
          created_by: string | null
          customer_id: string
          discount: number
          due_date: string | null
          id: string
          invoice_number: string
          issued_at: string | null
          status: string
          subtotal: number
          tax: number
          total: number
          updated_at: string | null
        }
        Insert: {
          branch_id: string
          club_id: string
          created_at?: string
          created_by?: string | null
          customer_id: string
          discount?: number
          due_date?: string | null
          id?: string
          invoice_number: string
          issued_at?: string | null
          status?: string
          subtotal?: number
          tax?: number
          total?: number
          updated_at?: string | null
        }
        Update: {
          branch_id?: string
          club_id?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string
          discount?: number
          due_date?: string | null
          id?: string
          invoice_number?: string
          issued_at?: string | null
          status?: string
          subtotal?: number
          tax?: number
          total?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
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
      payment_allocations: {
        Row: {
          amount: number
          created_at: string
          id: string
          invoice_id: string
          payment_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          invoice_id: string
          payment_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          invoice_id?: string
          payment_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_allocations_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "outstanding_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          branch_id: string
          club_id: string
          customer_id: string
          id: string
          method: string
          received_at: string
          received_by: string | null
          reference: string | null
          status: string
        }
        Insert: {
          amount: number
          branch_id: string
          club_id: string
          customer_id: string
          id?: string
          method: string
          received_at?: string
          received_by?: string | null
          reference?: string | null
          status?: string
        }
        Update: {
          amount?: number
          branch_id?: string
          club_id?: string
          customer_id?: string
          id?: string
          method?: string
          received_at?: string
          received_by?: string | null
          reference?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
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
      players: {
        Row: {
          club_id: string
          created_at: string
          created_by: string | null
          date_of_birth: string | null
          full_name: string
          gender: string | null
          id: string
          medical_notes: string | null
          photo_url: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          club_id: string
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          full_name: string
          gender?: string | null
          id?: string
          medical_notes?: string | null
          photo_url?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          club_id?: string
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          full_name?: string
          gender?: string | null
          id?: string
          medical_notes?: string | null
          photo_url?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "players_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_rules: {
        Row: {
          club_id: string
          created_at: string
          date_specific: string | null
          day_of_week: number | null
          end_time: string
          field_id: string | null
          id: string
          price_per_hour: number
          priority: number
          start_time: string
          updated_at: string | null
        }
        Insert: {
          club_id: string
          created_at?: string
          date_specific?: string | null
          day_of_week?: number | null
          end_time: string
          field_id?: string | null
          id?: string
          price_per_hour: number
          priority?: number
          start_time: string
          updated_at?: string | null
        }
        Update: {
          club_id?: string
          created_at?: string
          date_specific?: string | null
          day_of_week?: number | null
          end_time?: string
          field_id?: string | null
          id?: string
          price_per_hour?: number
          priority?: number
          start_time?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pricing_rules_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_rules_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
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
      programs: {
        Row: {
          club_id: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          name_ar: string
          sport: string | null
          status: string
          updated_at: string
        }
        Insert: {
          club_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          name_ar: string
          sport?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          club_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          name_ar?: string
          sport?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "programs_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      qr_credentials: {
        Row: {
          club_id: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          reference_id: string
          single_use: boolean
          status: string
          token_hash: string
          type: string
          used_at: string | null
          used_by: string | null
        }
        Insert: {
          club_id: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          reference_id: string
          single_use: boolean
          status?: string
          token_hash: string
          type: string
          used_at?: string | null
          used_by?: string | null
        }
        Update: {
          club_id?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          reference_id?: string
          single_use?: boolean
          status?: string
          token_hash?: string
          type?: string
          used_at?: string | null
          used_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "qr_credentials_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      qr_scan_events: {
        Row: {
          action: string
          club_id: string | null
          credential_id: string | null
          device_metadata: Json | null
          id: string
          reference_id: string | null
          reference_type: string | null
          result: string
          scanned_at: string
          scanner_user_id: string | null
        }
        Insert: {
          action: string
          club_id?: string | null
          credential_id?: string | null
          device_metadata?: Json | null
          id?: string
          reference_id?: string | null
          reference_type?: string | null
          result: string
          scanned_at?: string
          scanner_user_id?: string | null
        }
        Update: {
          action?: string
          club_id?: string | null
          credential_id?: string | null
          device_metadata?: Json | null
          id?: string
          reference_id?: string | null
          reference_type?: string | null
          result?: string
          scanned_at?: string
          scanner_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "qr_scan_events_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_scan_events_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "qr_credentials"
            referencedColumns: ["id"]
          },
        ]
      }
      refunds: {
        Row: {
          amount: number
          id: string
          payment_id: string
          reason: string
          refunded_at: string
          refunded_by: string | null
          status: string
        }
        Insert: {
          amount: number
          id?: string
          payment_id: string
          reason: string
          refunded_at?: string
          refunded_by?: string | null
          status?: string
        }
        Update: {
          amount?: number
          id?: string
          payment_id?: string
          reason?: string
          refunded_at?: string
          refunded_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
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
      seasons: {
        Row: {
          club_id: string
          created_at: string
          created_by: string | null
          end_date: string
          id: string
          name: string
          program_id: string | null
          start_date: string
        }
        Insert: {
          club_id: string
          created_at?: string
          created_by?: string | null
          end_date: string
          id?: string
          name: string
          program_id?: string | null
          start_date: string
        }
        Update: {
          club_id?: string
          created_at?: string
          created_by?: string | null
          end_date?: string
          id?: string
          name?: string
          program_id?: string | null
          start_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "seasons_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seasons_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "programs"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_freezes: {
        Row: {
          club_id: string
          created_at: string
          created_by: string | null
          end_date: string
          extends_expiry: boolean
          id: string
          reason: string | null
          start_date: string
          subscription_id: string
        }
        Insert: {
          club_id: string
          created_at?: string
          created_by?: string | null
          end_date: string
          extends_expiry?: boolean
          id?: string
          reason?: string | null
          start_date: string
          subscription_id: string
        }
        Update: {
          club_id?: string
          created_at?: string
          created_by?: string | null
          end_date?: string
          extends_expiry?: boolean
          id?: string
          reason?: string | null
          start_date?: string
          subscription_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_freezes_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_freezes_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          club_id: string
          created_at: string
          created_by: string | null
          discount: number
          end_date: string
          enrollment_id: string
          id: string
          invoice_id: string | null
          plan_type: string
          price: number
          start_date: string
          status: string
        }
        Insert: {
          club_id: string
          created_at?: string
          created_by?: string | null
          discount?: number
          end_date: string
          enrollment_id: string
          id?: string
          invoice_id?: string | null
          plan_type: string
          price: number
          start_date: string
          status?: string
        }
        Update: {
          club_id?: string
          created_at?: string
          created_by?: string | null
          discount?: number
          end_date?: string
          enrollment_id?: string
          id?: string
          invoice_id?: string | null
          plan_type?: string
          price?: number
          start_date?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: true
            referencedRelation: "enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "outstanding_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      training_sessions: {
        Row: {
          club_id: string
          coach_id: string | null
          created_at: string
          end_time: string
          field_id: string | null
          group_id: string
          id: string
          session_date: string
          start_time: string
          status: string
        }
        Insert: {
          club_id: string
          coach_id?: string | null
          created_at?: string
          end_time: string
          field_id?: string | null
          group_id: string
          id?: string
          session_date: string
          start_time: string
          status?: string
        }
        Update: {
          club_id?: string
          coach_id?: string | null
          created_at?: string
          end_time?: string
          field_id?: string | null
          group_id?: string
          id?: string
          session_date?: string
          start_time?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "training_sessions_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "training_sessions_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "training_sessions_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
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
      outstanding_invoices: {
        Row: {
          branch_id: string | null
          club_id: string | null
          customer_id: string | null
          customer_name: string | null
          days_overdue: number | null
          due_date: string | null
          id: string | null
          invoice_number: string | null
          issued_at: string | null
          normalized_mobile: string | null
          outstanding: number | null
          status: string | null
          total: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      players_safe: {
        Row: {
          club_id: string | null
          created_at: string | null
          created_by: string | null
          date_of_birth: string | null
          full_name: string | null
          gender: string | null
          id: string | null
          photo_url: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          club_id?: string | null
          created_at?: string | null
          created_by?: string | null
          date_of_birth?: string | null
          full_name?: string | null
          gender?: string | null
          id?: string | null
          photo_url?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          club_id?: string | null
          created_at?: string | null
          created_by?: string | null
          date_of_birth?: string | null
          full_name?: string | null
          gender?: string | null
          id?: string | null
          photo_url?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "players_club_id_fkey"
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
      _activate_subscription_if_due_internal: {
        Args: { p_subscription_id: string }
        Returns: boolean
      }
      _create_booking_internal: {
        Args: {
          p_booking_series_id: string
          p_customer_id: string
          p_discount_amount: number
          p_end_at: string
          p_field_id: string
          p_notes: string
          p_payment_amount: number
          p_payment_method: string
          p_record_payment: boolean
          p_start_at: string
        }
        Returns: string
      }
      activate_subscription_if_due: {
        Args: { p_subscription_id: string }
        Returns: boolean
      }
      cancel_booking: {
        Args: { p_booking_id: string; p_reason: string }
        Returns: undefined
      }
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
      complete_new_club_onboarding: {
        Args: {
          p_branch_name: string
          p_business_type: string
          p_city: string
          p_club_name: string
          p_club_name_ar: string
          p_owner_email: string
          p_owner_mobile: string
          p_phone: string
        }
        Returns: {
          club_id: string
          trial_granted: boolean
        }[]
      }
      create_booking: {
        Args: {
          p_customer_id: string
          p_discount_amount?: number
          p_end_at: string
          p_field_id: string
          p_notes?: string
          p_payment_amount?: number
          p_payment_method?: string
          p_record_payment?: boolean
          p_start_at: string
        }
        Returns: string
      }
      create_enrollment_with_subscription: {
        Args: {
          p_discount?: number
          p_end_date: string
          p_group_id: string
          p_guardian_id: string
          p_plan_type: string
          p_player_id: string
          p_price: number
          p_start_date: string
        }
        Returns: {
          enrollment_id: string
          invoice_id: string
          subscription_id: string
        }[]
      }
      create_field_block: {
        Args: {
          p_end_at: string
          p_field_id: string
          p_reason?: string
          p_start_at: string
          p_type: string
        }
        Returns: {
          block_id: string
          conflicting_booking_ids: string[]
        }[]
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
      create_recurring_booking: {
        Args: {
          p_customer_id: string
          p_field_id: string
          p_first_end_at: string
          p_first_start_at: string
          p_interval_days?: number
          p_occurrence_count: number
        }
        Returns: {
          conflicted_occurrences: string[]
          created: number
          requested: number
          series_id: string
        }[]
      }
      create_refund: {
        Args: { p_amount: number; p_payment_id: string; p_reason: string }
        Returns: string
      }
      deactivate_staff_member: {
        Args: { p_membership_id: string }
        Returns: undefined
      }
      ensure_booking_qr: { Args: { p_booking_id: string }; Returns: string }
      extend_grace_period: {
        Args: { p_grace_period_days: number; p_subscription_id: string }
        Returns: undefined
      }
      freeze_subscription: {
        Args: {
          p_end_date: string
          p_extends_expiry?: boolean
          p_reason?: string
          p_start_date: string
          p_subscription_id: string
        }
        Returns: string
      }
      generate_training_sessions: {
        Args: { p_group_id: string; p_through_date: string }
        Returns: number
      }
      get_academy_report: {
        Args: { p_club_id: string; p_end_date: string; p_start_date: string }
        Returns: Json
      }
      get_club_platform_access: { Args: { p_club_id: string }; Returns: string }
      get_customer_activity_report: {
        Args: { p_club_id: string; p_end_date: string; p_start_date: string }
        Returns: Json
      }
      get_field_occupancy_report: {
        Args: {
          p_club_id: string
          p_end_date: string
          p_field_id?: string
          p_start_date: string
        }
        Returns: Json
      }
      get_revenue_report: {
        Args: {
          p_branch_id?: string
          p_club_id: string
          p_end_date: string
          p_method?: string
          p_start_date: string
        }
        Returns: Json
      }
      get_subscription_effective_end_date: {
        Args: { p_subscription_id: string }
        Returns: string
      }
      get_today_dashboard: { Args: { p_club_id: string }; Returns: Json }
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
      is_platform_owner: { Args: never; Returns: boolean }
      issue_invoice_number: {
        Args: { p_branch_id: string; p_club_id: string }
        Returns: string
      }
      mark_attendance: {
        Args: { p_player_id: string; p_session_id: string; p_status: string }
        Returns: string
      }
      mark_booking_no_show: {
        Args: { p_booking_id: string; p_reason?: string }
        Returns: undefined
      }
      normalize_mobile: { Args: { p_mobile: string }; Returns: string }
      qr_confirm_checkin: {
        Args: { p_token: string }
        Returns: {
          booking_id: string
          result: string
        }[]
      }
      qr_mark_attendance: {
        Args: { p_session_id: string; p_token: string }
        Returns: {
          attendance_id: string
          result: string
        }[]
      }
      qr_validate: {
        Args: { p_token: string }
        Returns: {
          club_id: string
          credential_id: string
          reference_id: string
          reference_type: string
          result: string
        }[]
      }
      record_payment: {
        Args: {
          p_amount: number
          p_invoice_id: string
          p_method: string
          p_reference?: string
        }
        Returns: string
      }
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
      resolve_field_price: {
        Args: {
          p_date: string
          p_end_time: string
          p_field_id: string
          p_start_time: string
        }
        Returns: number
      }
      reverse_platform_payment: {
        Args: { p_payment_id: string; p_reason: string }
        Returns: undefined
      }
      set_plan_publish_status: {
        Args: { p_is_public: boolean; p_plan_id: string }
        Returns: undefined
      }
      user_club_ids: { Args: never; Returns: string[] }
      void_invoice: {
        Args: { p_invoice_id: string; p_reason: string }
        Returns: undefined
      }
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

