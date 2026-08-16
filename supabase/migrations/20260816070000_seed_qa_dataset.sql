-- V1 Operational Product Rebuild (2026-08-16): realistic QA dataset for
-- visual/product verification per the work order's Section B. A single
-- clearly-identifiable club ("نادي الاختبار الشامل" / club_code QAFULL)
-- with 2 branches, 5 fields with varied hours/pricing, 25 customers, a
-- full realistic day of bookings across every status, finance examples,
-- and a full academy structure. Owned by moustafa.elsafy2@gmail.com so
-- it's reachable through the already-proven auth session.
do $$
declare
  v_owner_id uuid;
  v_club_id uuid;
  v_branch1_id uuid;
  v_branch2_id uuid;
  v_field1_id uuid; -- branch1, football, full hours, tiered pricing
  v_field2_id uuid; -- branch1, football, full hours, flat pricing
  v_field3_id uuid; -- branch1, padel, limited hours (closed Friday)
  v_field4_id uuid; -- branch2, football, no configured hours (unrestricted case)
  v_field5_id uuid; -- branch2, basketball, inactive
  v_customer_ids uuid[] := '{}';
  v_cust_id uuid;
  v_role_club_owner uuid;
  v_program1_id uuid;
  v_program2_id uuid;
  v_season1_id uuid;
  v_age_group_u10 uuid;
  v_age_group_u14 uuid;
  v_age_group_adult uuid;
  v_group1_id uuid; -- U10 football, near capacity (17/20)
  v_group2_id uuid; -- U14 football
  v_group3_id uuid; -- Adult padel
  v_group4_id uuid; -- U10 basketball @ branch2, low enrollment
  v_player_ids uuid[] := '{}';
  v_player_id uuid;
  v_guardian_id uuid;
  v_enroll_id uuid;
  v_booking_id uuid;
  v_invoice_id uuid;
  v_payment_id uuid;
  v_series_id uuid;
  v_session_id uuid;
  v_subscription_id uuid;
  v_today date := current_date;
  i int;
  v_names text[] := ARRAY['أحمد محمد','محمود علي','خالد إبراهيم','عمر حسن','يوسف سعيد','مصطفى كمال','كريم عادل','طارق فؤاد','هشام رضا','سامح جمال','وائل نبيل','هاني عصام','رامي أشرف','باسم صبري','شريف منير','أدهم لطفي','فادي ماجد','بيشوي جرجس','مينا فايز','جورج عاطف','ياسمين محمد','مريم أحمد','نور الهدى','سارة كمال','دينا حسام'];
begin
  select id into v_owner_id from auth.users where email = 'moustafa.elsafy2@gmail.com';
  if v_owner_id is null then
    raise exception 'moustafa.elsafy2@gmail.com not found';
  end if;
  select id into v_role_club_owner from public.roles where key = 'club_owner';

  -- ============================================================
  -- Club + Branches
  -- ============================================================
  insert into public.clubs (name, name_ar, name_en, club_code, currency, timezone, status, subscription_activation_policy)
  values ('QA Full Test Club', 'نادي الاختبار الشامل', 'QA Full Test Club', 'QAFULL', 'EGP', 'Africa/Cairo', 'active', 'first_payment')
  returning id into v_club_id;

  insert into public.branches (club_id, branch_code, name, address, phone, status)
  values (v_club_id, 'MAIN', 'الفرع الرئيسي - مدينة نصر', 'شارع عباس العقاد، مدينة نصر، القاهرة', '0221234567', 'active')
  returning id into v_branch1_id;

  insert into public.branches (club_id, branch_code, name, address, phone, status)
  values (v_club_id, 'NASR', 'فرع الشيخ زايد', 'محور 26 يوليو، الشيخ زايد، الجيزة', '0233445566', 'active')
  returning id into v_branch2_id;

  insert into public.club_memberships (user_id, club_id, role_id, status)
  values (v_owner_id, v_club_id, v_role_club_owner, 'active');

  insert into public.platform_subscriptions (club_id, plan_id, subscription_kind, plan_name_snapshot, price_snapshot, currency_snapshot, interval_snapshot, interval_count_snapshot, grace_period_days_snapshot, start_at, end_at, lifecycle_status)
  values (v_club_id, null, 'trial', 'تجربة مجانية', 0, 'EGP', null, null, 0, now(), now() + interval '7 days', 'trial');

  -- ============================================================
  -- Fields
  -- ============================================================
  insert into public.fields (club_id, branch_id, name, sport, status)
  values (v_club_id, v_branch1_id, 'ملعب 1 - كرة قدم (رئيسي)', 'football', 'active') returning id into v_field1_id;
  insert into public.fields (club_id, branch_id, name, sport, status)
  values (v_club_id, v_branch1_id, 'ملعب 2 - كرة قدم', 'football', 'active') returning id into v_field2_id;
  insert into public.fields (club_id, branch_id, name, sport, status)
  values (v_club_id, v_branch1_id, 'ملعب بادل 1', 'padel', 'active') returning id into v_field3_id;
  insert into public.fields (club_id, branch_id, name, sport, status)
  values (v_club_id, v_branch2_id, 'ملعب 1 - كرة قدم', 'football', 'active') returning id into v_field4_id;
  insert into public.fields (club_id, branch_id, name, sport, status, maintenance_status)
  values (v_club_id, v_branch2_id, 'ملعب كرة سلة (تحت الصيانة)', 'basketball', 'inactive', 'under_maintenance') returning id into v_field5_id;

  -- Operating hours: field1 full week 08:00-23:00.
  for i in 0..6 loop
    insert into public.field_operating_hours (club_id, branch_id, field_id, day_of_week, open_time, close_time)
    values (v_club_id, v_branch1_id, v_field1_id, i, '08:00', '23:00');
  end loop;
  -- field2: full week but shorter hours 09:00-22:00.
  for i in 0..6 loop
    insert into public.field_operating_hours (club_id, branch_id, field_id, day_of_week, open_time, close_time)
    values (v_club_id, v_branch1_id, v_field2_id, i, '09:00', '22:00');
  end loop;
  -- field3 (padel): limited hours, closed Friday (dow=5).
  for i in 0..6 loop
    if i <> 5 then
      insert into public.field_operating_hours (club_id, branch_id, field_id, day_of_week, open_time, close_time)
      values (v_club_id, v_branch1_id, v_field3_id, i, '10:00', '20:00');
    end if;
  end loop;
  -- field4: intentionally no hours rows configured -- the
  -- "unrestricted/all-hours" convention this schema uses, and the case
  -- the earlier gap audit found unhandled in the UI.

  -- Pricing: field1 -- weekday off-peak/peak tiers + Friday/Saturday
  -- flat + one date-specific holiday override.
  for i in 0..6 loop
    if i between 0 and 4 then
      insert into public.pricing_rules (club_id, field_id, day_of_week, start_time, end_time, price_per_hour, priority)
      values (v_club_id, v_field1_id, i, '08:00', '16:00', 200, 1);
      insert into public.pricing_rules (club_id, field_id, day_of_week, start_time, end_time, price_per_hour, priority)
      values (v_club_id, v_field1_id, i, '16:00', '23:00', 300, 1);
    else
      insert into public.pricing_rules (club_id, field_id, day_of_week, start_time, end_time, price_per_hour, priority)
      values (v_club_id, v_field1_id, i, '08:00', '23:00', 350, 1);
    end if;
  end loop;
  insert into public.pricing_rules (club_id, field_id, date_specific, start_time, end_time, price_per_hour, priority)
  values (v_club_id, v_field1_id, v_today + 10, '08:00', '23:00', 400, 10);

  -- field2: flat pricing, one rate all week.
  for i in 0..6 loop
    insert into public.pricing_rules (club_id, field_id, day_of_week, start_time, end_time, price_per_hour, priority)
    values (v_club_id, v_field2_id, i, '09:00', '22:00', 250, 1);
  end loop;

  -- field3 (padel): flat, higher rate.
  for i in 0..6 loop
    if i <> 5 then
      insert into public.pricing_rules (club_id, field_id, day_of_week, start_time, end_time, price_per_hour, priority)
      values (v_club_id, v_field3_id, i, '10:00', '20:00', 300, 1);
    end if;
  end loop;

  -- field4: pricing exists even though hours don't.
  for i in 0..6 loop
    insert into public.pricing_rules (club_id, field_id, day_of_week, start_time, end_time, price_per_hour, priority)
    values (v_club_id, v_field4_id, i, '00:00', '23:59', 220, 1);
  end loop;

  -- A maintenance block on field2, tomorrow morning.
  insert into public.field_blocks (club_id, field_id, start_at, end_at, type, reason, created_by)
  values (v_club_id, v_field2_id, (v_today + 1)::timestamptz + interval '9 hours', (v_today + 1)::timestamptz + interval '12 hours', 'maintenance', 'صيانة أرضية الملعب', v_owner_id);

  -- ============================================================
  -- Customers (25)
  -- ============================================================
  for i in 1..25 loop
    insert into public.customers (club_id, full_name, mobile_display, normalized_mobile, email)
    values (v_club_id, v_names[i], '010' || lpad(i::text, 8, '0'), '2010' || lpad(i::text, 8, '0'), 'customer' || i || '@example.com')
    returning id into v_cust_id;
    v_customer_ids := array_append(v_customer_ids, v_cust_id);
  end loop;

  -- ============================================================
  -- Bookings: a full realistic today across every status + a recurring
  -- series + adjacent bookings, on field1/field2/field3/field4.
  -- ============================================================

  -- 1) Completed morning booking, fully paid.
  insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, created_by)
  values (v_club_id, v_branch1_id, v_field1_id, v_customer_ids[1], v_today::timestamptz + interval '9 hours', v_today::timestamptz + interval '10 hours', 'completed', 200, 0, v_owner_id)
  returning id into v_booking_id;
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch1_id, public.issue_invoice_number(v_branch1_id, v_club_id), v_customer_ids[1], 'issued', 200, 0, 200, now(), v_owner_id)
  returning id into v_invoice_id;
  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;
  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ملعب 1 - كرة قدم (رئيسي)', 'booking', v_booking_id, 1, 200, 200);
  insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by, received_at)
  values (v_club_id, v_branch1_id, v_customer_ids[1], 'cash', 200, v_owner_id, now())
  returning id into v_payment_id;
  insert into public.payment_allocations (payment_id, invoice_id, amount) values (v_payment_id, v_invoice_id, 200);

  -- 2) Confirmed + paid, adjacent pair on field1 (11:00-12:00).
  insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, created_by)
  values (v_club_id, v_branch1_id, v_field1_id, v_customer_ids[2], v_today::timestamptz + interval '11 hours', v_today::timestamptz + interval '12 hours', 'confirmed', 200, 0, v_owner_id)
  returning id into v_booking_id;
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch1_id, public.issue_invoice_number(v_branch1_id, v_club_id), v_customer_ids[2], 'issued', 200, 0, 200, now(), v_owner_id)
  returning id into v_invoice_id;
  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;
  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ملعب 1 - كرة قدم (رئيسي)', 'booking', v_booking_id, 1, 200, 200);
  insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by, received_at)
  values (v_club_id, v_branch1_id, v_customer_ids[2], 'cash', 200, v_owner_id, now())
  returning id into v_payment_id;
  insert into public.payment_allocations (payment_id, invoice_id, amount) values (v_payment_id, v_invoice_id, 200);

  -- 3) Pending payment, adjacent (12:00-13:00) -- outstanding invoice example.
  insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, created_by)
  values (v_club_id, v_branch1_id, v_field1_id, v_customer_ids[3], v_today::timestamptz + interval '12 hours', v_today::timestamptz + interval '13 hours', 'pending_payment', 200, 0, v_owner_id)
  returning id into v_booking_id;
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch1_id, public.issue_invoice_number(v_branch1_id, v_club_id), v_customer_ids[3], 'issued', 200, 0, 200, now(), v_owner_id)
  returning id into v_invoice_id;
  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;
  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ملعب 1 - كرة قدم (رئيسي)', 'booking', v_booking_id, 1, 200, 200);

  -- 4) Checked-in, early afternoon, partially paid.
  insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, marked_by, marked_at, created_by)
  values (v_club_id, v_branch1_id, v_field2_id, v_customer_ids[4], v_today::timestamptz + interval '14 hours', v_today::timestamptz + interval '15 hours', 'checked_in', 250, 0, v_owner_id, now(), v_owner_id)
  returning id into v_booking_id;
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch1_id, public.issue_invoice_number(v_branch1_id, v_club_id), v_customer_ids[4], 'issued', 250, 0, 250, now(), v_owner_id)
  returning id into v_invoice_id;
  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;
  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ملعب 2 - كرة قدم', 'booking', v_booking_id, 1, 250, 250);
  insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by, received_at)
  values (v_club_id, v_branch1_id, v_customer_ids[4], 'cash', 100, v_owner_id, now())
  returning id into v_payment_id;
  insert into public.payment_allocations (payment_id, invoice_id, amount) values (v_payment_id, v_invoice_id, 100);

  -- 5) Cancelled example (padel, afternoon).
  insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, cancelled_reason, cancelled_by, cancelled_at, created_by)
  values (v_club_id, v_branch1_id, v_field3_id, v_customer_ids[5], v_today::timestamptz + interval '16 hours', v_today::timestamptz + interval '17 hours', 'cancelled', 300, 0, 'طلب العميل الإلغاء', v_owner_id, now(), v_owner_id);

  -- 6) No-show example (padel, midday).
  insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, marked_by, marked_at, created_by)
  values (v_club_id, v_branch1_id, v_field3_id, v_customer_ids[6], v_today::timestamptz + interval '13 hours', v_today::timestamptz + interval '14 hours', 'no_show', 300, 0, v_owner_id, now(), v_owner_id);

  -- 7) Evening pending payment on field1.
  insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, created_by)
  values (v_club_id, v_branch1_id, v_field1_id, v_customer_ids[7], v_today::timestamptz + interval '19 hours', v_today::timestamptz + interval '20 hours', 'pending_payment', 300, 0, v_owner_id)
  returning id into v_booking_id;
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch1_id, public.issue_invoice_number(v_branch1_id, v_club_id), v_customer_ids[7], 'issued', 300, 0, 300, now(), v_owner_id)
  returning id into v_invoice_id;
  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;
  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ملعب 1 - كرة قدم (رئيسي)', 'booking', v_booking_id, 1, 300, 300);

  -- 8) Recurring series (booking_series, 3 weekly occurrences on field4/branch2).
  insert into public.booking_series (club_id, field_id, customer_id, pattern_description, requested_occurrences, created_occurrences, created_by)
  values (v_club_id, v_field4_id, v_customer_ids[8], 'أسبوعي - كل يوم سبت 17:00-18:00', 3, 3, v_owner_id)
  returning id into v_series_id;
  for i in 0..2 loop
    insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, booking_series_id, created_by)
    values (v_club_id, v_branch2_id, v_field4_id, v_customer_ids[8], (v_today + (i * 7))::timestamptz + interval '17 hours', (v_today + (i * 7))::timestamptz + interval '18 hours', 'confirmed', 220, 0, v_series_id, v_owner_id);
  end loop;

  -- 9) field4 booking, fully paid then partially refunded (finance example).
  insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, created_by)
  values (v_club_id, v_branch2_id, v_field4_id, v_customer_ids[9], v_today::timestamptz + interval '20 hours', v_today::timestamptz + interval '21 hours', 'confirmed', 220, 0, v_owner_id)
  returning id into v_booking_id;
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch2_id, public.issue_invoice_number(v_branch2_id, v_club_id), v_customer_ids[9], 'issued', 220, 0, 220, now(), v_owner_id)
  returning id into v_invoice_id;
  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;
  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ملعب 1 - كرة قدم', 'booking', v_booking_id, 1, 220, 220);
  insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by, received_at)
  values (v_club_id, v_branch2_id, v_customer_ids[9], 'card', 220, v_owner_id, now())
  returning id into v_payment_id;
  insert into public.payment_allocations (payment_id, invoice_id, amount) values (v_payment_id, v_invoice_id, 220);
  -- create_refund() requires an authenticated session (auth.uid()) for
  -- its actor/audit fields, which a migration script running as the
  -- Postgres superuser doesn't have -- insert the refund row directly
  -- instead, matching exactly what that RPC would have produced.
  insert into public.refunds (payment_id, amount, reason, status, refunded_by)
  values (v_payment_id, 50, 'استرجاع جزئي بطلب العميل', 'completed', v_owner_id);

  -- ============================================================
  -- Academy: 2 programs, 1 season, 3 age groups, 4 groups, 20 players.
  -- ============================================================
  insert into public.programs (club_id, name, name_ar, sport, status)
  values (v_club_id, 'Football Academy', 'أكاديمية كرة القدم', 'football', 'active') returning id into v_program1_id;
  insert into public.programs (club_id, name, name_ar, sport, status)
  values (v_club_id, 'Padel Academy', 'أكاديمية البادل', 'padel', 'active') returning id into v_program2_id;

  insert into public.seasons (club_id, program_id, name, start_date, end_date)
  values (v_club_id, v_program1_id, 'موسم الخريف 2026', v_today - 30, v_today + 90)
  returning id into v_season1_id;

  insert into public.age_groups (club_id, name, min_age, max_age) values (v_club_id, 'U10', 8, 10) returning id into v_age_group_u10;
  insert into public.age_groups (club_id, name, min_age, max_age) values (v_club_id, 'U14', 11, 14) returning id into v_age_group_u14;
  insert into public.age_groups (club_id, name, min_age, max_age) values (v_club_id, 'كبار', 18, 45) returning id into v_age_group_adult;

  insert into public.groups (club_id, branch_id, program_id, season_id, age_group_id, field_id, name, capacity, status)
  values (v_club_id, v_branch1_id, v_program1_id, v_season1_id, v_age_group_u10, v_field1_id, 'مجموعة U10 - أ', 20, 'active')
  returning id into v_group1_id;
  insert into public.groups (club_id, branch_id, program_id, season_id, age_group_id, field_id, name, capacity, status)
  values (v_club_id, v_branch1_id, v_program1_id, v_season1_id, v_age_group_u14, v_field2_id, 'مجموعة U14', 16, 'active')
  returning id into v_group2_id;
  insert into public.groups (club_id, branch_id, program_id, season_id, age_group_id, field_id, name, capacity, status)
  values (v_club_id, v_branch1_id, v_program2_id, v_season1_id, v_age_group_adult, v_field3_id, 'مجموعة البادل - كبار', 12, 'active')
  returning id into v_group3_id;
  insert into public.groups (club_id, branch_id, program_id, season_id, age_group_id, field_id, name, capacity, status)
  values (v_club_id, v_branch2_id, v_program1_id, v_season1_id, v_age_group_u10, v_field4_id, 'مجموعة U10 - ب (فرع الشيخ زايد)', 20, 'active')
  returning id into v_group4_id;

  insert into public.group_schedule_slots (group_id, day_of_week, start_time, end_time) values (v_group1_id, 0, '16:00', '17:30');
  insert into public.group_schedule_slots (group_id, day_of_week, start_time, end_time) values (v_group1_id, 2, '16:00', '17:30');
  insert into public.group_schedule_slots (group_id, day_of_week, start_time, end_time) values (v_group2_id, 1, '17:00', '18:30');
  insert into public.group_schedule_slots (group_id, day_of_week, start_time, end_time) values (v_group2_id, 3, '17:00', '18:30');
  insert into public.group_schedule_slots (group_id, day_of_week, start_time, end_time) values (v_group3_id, 4, '19:00', '20:30');
  insert into public.group_schedule_slots (group_id, day_of_week, start_time, end_time) values (v_group4_id, 6, '16:00', '17:00');

  -- 20 players: 17 into group1 (near capacity, 20 cap), 3 into group4 (low enrollment).
  for i in 1..20 loop
    insert into public.players (club_id, full_name, date_of_birth, gender, status)
    values (
      v_club_id,
      'لاعب ' || v_names[((i - 1) % 25) + 1],
      (v_today - ((9 + (i % 3)) * 365))::date,
      case when i % 4 = 0 then 'female' else 'male' end,
      'active'
    )
    returning id into v_player_id;
    v_player_ids := array_append(v_player_ids, v_player_id);

    -- Link the same-index customer as guardian (billing guardian).
    v_guardian_id := v_customer_ids[((i - 1) % 25) + 1];
    insert into public.guardian_links (customer_id, player_id, relationship, is_primary)
    values (v_guardian_id, v_player_id, 'father', true);

    if i <= 17 then
      -- Group1 (U10-A), varied subscription states.
      insert into public.enrollments (club_id, player_id, group_id, guardian_id, status, enrolled_at)
      values (v_club_id, v_player_id, v_group1_id, v_guardian_id, 'active', now() - ((20 - i) || ' days')::interval)
      returning id into v_enroll_id;

      insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
      values (v_club_id, v_branch1_id, public.issue_invoice_number(v_branch1_id, v_club_id), v_guardian_id, 'issued', 500, 0, 500, now(), v_owner_id)
      returning id into v_invoice_id;
      insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
      values (v_invoice_id, 'اشتراك أكاديمية - مجموعة U10 - أ', 'subscription', v_enroll_id, 1, 500, 500);

      if i <= 10 then
        -- Paid, active, comfortably in the future.
        insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id)
        values (v_club_id, v_enroll_id, 'monthly', v_today - 10, v_today + 20, 500, 0, 'active', v_invoice_id);
        insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by, received_at)
        values (v_club_id, v_branch1_id, v_guardian_id, 'cash', 500, v_owner_id, now())
        returning id into v_payment_id;
        insert into public.payment_allocations (payment_id, invoice_id, amount) values (v_payment_id, v_invoice_id, 500);
      elsif i <= 14 then
        -- Approaching expiry (within 3-5 days) -- paid.
        insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id)
        values (v_club_id, v_enroll_id, 'monthly', v_today - 27, v_today + 3, 500, 0, 'active', v_invoice_id);
        insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by, received_at)
        values (v_club_id, v_branch1_id, v_guardian_id, 'cash', 500, v_owner_id, now())
        returning id into v_payment_id;
        insert into public.payment_allocations (payment_id, invoice_id, amount) values (v_payment_id, v_invoice_id, 500);
      elsif i <= 16 then
        -- Unpaid / pending activation.
        insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id)
        values (v_club_id, v_enroll_id, 'monthly', v_today, v_today + 30, 500, 0, 'pending', v_invoice_id);
      else
        -- Frozen example (the 17th).
        insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id)
        values (v_club_id, v_enroll_id, 'monthly', v_today - 15, v_today + 15, 500, 0, 'active', v_invoice_id)
        returning id into v_subscription_id;
        insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by, received_at)
        values (v_club_id, v_branch1_id, v_guardian_id, 'cash', 500, v_owner_id, now())
        returning id into v_payment_id;
        insert into public.payment_allocations (payment_id, invoice_id, amount) values (v_payment_id, v_invoice_id, 500);
        insert into public.subscription_freezes (club_id, subscription_id, start_date, end_date, reason, extends_expiry, created_by)
        values (v_club_id, v_subscription_id, v_today - 5, v_today, 'سفر العائلة', true, v_owner_id);
      end if;
    else
      -- Remaining 3 players into group4 (low enrollment, 20 capacity -> looks empty).
      insert into public.enrollments (club_id, player_id, group_id, guardian_id, status, enrolled_at)
      values (v_club_id, v_player_id, v_group4_id, v_guardian_id, 'active', now() - '5 days'::interval)
      returning id into v_enroll_id;
      insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
      values (v_club_id, v_branch2_id, public.issue_invoice_number(v_branch2_id, v_club_id), v_guardian_id, 'issued', 450, 0, 450, now(), v_owner_id)
      returning id into v_invoice_id;
      insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
      values (v_invoice_id, 'اشتراك أكاديمية - مجموعة U10 - ب', 'subscription', v_enroll_id, 1, 450, 450);
      insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id)
      values (v_club_id, v_enroll_id, 'monthly', v_today - 5, v_today + 25, 450, 0, 'pending', v_invoice_id);
    end if;
  end loop;

  -- Training sessions for group1 (today + a past session, for attendance history).
  insert into public.training_sessions (club_id, group_id, field_id, session_date, start_time, end_time, status)
  values (v_club_id, v_group1_id, v_field1_id, v_today, '16:00', '17:30', 'scheduled')
  returning id into v_session_id;
  for i in 1..10 loop
    insert into public.attendance (club_id, session_id, player_id, status, method, marked_by, marked_at)
    values (v_club_id, v_session_id, v_player_ids[i], case when i <= 8 then 'present' else 'absent' end, 'manual', v_owner_id, now());
  end loop;

  insert into public.training_sessions (club_id, group_id, field_id, session_date, start_time, end_time, status)
  values (v_club_id, v_group1_id, v_field1_id, v_today - 2, '16:00', '17:30', 'completed')
  returning id into v_session_id;
  for i in 1..17 loop
    insert into public.attendance (club_id, session_id, player_id, status, method, marked_by, marked_at)
    values (v_club_id, v_session_id, v_player_ids[i], case when i % 5 = 0 then 'absent' else 'present' end, 'manual', v_owner_id, now() - interval '2 days');
  end loop;

  -- Today's group2 session, left unmarked (attendance-incomplete example).
  insert into public.training_sessions (club_id, group_id, field_id, session_date, start_time, end_time, status)
  values (v_club_id, v_group2_id, v_field2_id, v_today, '17:00', '18:30', 'scheduled');

  raise notice 'QA dataset seeded: club_id=%', v_club_id;
end $$;
