-- ============================================================
-- DongDib & Suan CRM — Supabase Schema
-- วิธีใช้: เปิด Supabase Dashboard > SQL Editor > วาง SQL นี้ > Run
-- ============================================================

-- ตาราง customers
create table if not exists customers (
  id          bigserial primary key,
  name        text        not null,
  tel         text        default '',
  dob         text        default '',
  age         integer,
  sex         text        default '',
  id_num      text        default '',
  occ         text        default '',
  bene        text        default '',
  rel         text        default '',
  address     text        default '',
  biz         text        not null default 'stay',  -- 'hike' | 'stay' | 'both'
  status      text        not null default 'Newbie', -- 'Newbie' | 'Regular' | 'Legend'
  visits      integer     not null default 1,
  last_check_in text      default '',
  last_room   text        default '',
  source      text        default 'manual',          -- 'manual' | 'agoda' | 'booking'
  med         text        default '',
  note        text        default '',
  created_at  timestamptz default now()
);

-- ตาราง bookings (ประวัติการจอง)
create table if not exists bookings (
  id          bigserial primary key,
  customer_id bigint references customers(id) on delete cascade,
  booking_id  text        default '',
  check_in    text        default '',
  check_out   text        default '',
  room_name   text        default '',
  guests      integer     default 1,
  nights      integer     default 1,
  price       numeric     default 0,
  commission  numeric     default 0,
  created_at  timestamptz default now()
);

-- Index เพื่อความเร็ว
create index if not exists idx_customers_name   on customers(name);
create index if not exists idx_customers_biz    on customers(biz);
create index if not exists idx_customers_status on customers(status);
create index if not exists idx_bookings_customer on bookings(customer_id);

-- Enable Row Level Security (RLS)
alter table customers enable row level security;
alter table bookings  enable row level security;

-- Policy: อนุญาตให้ anon key อ่าน/เขียนได้
-- (สำหรับ internal tool ที่ไม่มี login — ถ้าอยากเพิ่ม auth ทีหลังได้เลย)
create policy "allow all customers" on customers for all using (true) with check (true);
create policy "allow all bookings"  on bookings  for all using (true) with check (true);
