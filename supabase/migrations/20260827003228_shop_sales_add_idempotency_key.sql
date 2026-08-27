alter table public.shop_sales add column idempotency_key uuid;
create unique index shop_sales_club_idempotency_key_unique
  on public.shop_sales(club_id, idempotency_key) where idempotency_key is not null;
