-- Gate 3 continued: My Academies / My Children screen needs read
-- access, scoped strictly to "players this account is a linked
-- guardian of," across guardian_links -> players -> enrollments ->
-- groups -> subscriptions. Every policy below chains back to
-- customers.user_id = auth.uid() so a self-service account can never
-- see another family's children or another club's academy structure.
create policy "guardian_links_self_service_select" on public.guardian_links
  for select using (
    customer_id in (select id from public.customers where user_id = auth.uid())
  );

create policy "players_self_service_select" on public.players
  for select using (
    id in (
      select gl.player_id from public.guardian_links gl
      join public.customers c on c.id = gl.customer_id
      where c.user_id = auth.uid()
    )
  );

create policy "enrollments_self_service_select" on public.enrollments
  for select using (
    player_id in (
      select gl.player_id from public.guardian_links gl
      join public.customers c on c.id = gl.customer_id
      where c.user_id = auth.uid()
    )
  );

create policy "groups_self_service_select" on public.groups
  for select using (
    id in (
      select e.group_id from public.enrollments e
      join public.guardian_links gl on gl.player_id = e.player_id
      join public.customers c on c.id = gl.customer_id
      where c.user_id = auth.uid()
    )
  );

create policy "subscriptions_self_service_select" on public.subscriptions
  for select using (
    enrollment_id in (
      select e.id from public.enrollments e
      join public.guardian_links gl on gl.player_id = e.player_id
      join public.customers c on c.id = gl.customer_id
      where c.user_id = auth.uid()
    )
  );
