-- WRLD ENT schema (Supabase / Postgres)
-- Run this in the Supabase SQL Editor.

create extension if not exists "pgcrypto";

-- Users
create table if not exists public.users (
  uuid uuid primary key,
  username text not null unique,
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- Sessions (cookie SID stored server-side)
create table if not exists public.sessions (
  sid text primary key,
  user_uuid uuid not null references public.users(uuid) on delete cascade,
  username text not null,
  email text not null,
  device_tag text not null,
  remember_me boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists idx_sessions_user_uuid on public.sessions(user_uuid);
create index if not exists idx_sessions_expires_at on public.sessions(expires_at);

-- Announcements
create table if not exists public.announcements (
  id bigserial primary key,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_announcements_created_at on public.announcements(created_at desc);

-- API keys (for device agent)
create table if not exists public.api_keys (
  id bigserial primary key,
  user_uuid uuid not null references public.users(uuid) on delete cascade,
  label text not null default 'Default',
  api_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists idx_api_keys_user_uuid on public.api_keys(user_uuid);

-- Device reports
create table if not exists public.device_reports (
  id bigserial primary key,
  user_uuid uuid not null references public.users(uuid) on delete cascade,
  device_tag text not null,
  apps_json jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique(user_uuid, device_tag)
);
create index if not exists idx_device_reports_user_device on public.device_reports(user_uuid, device_tag);

-- Password resets
create table if not exists public.password_resets (
  id bigserial primary key,
  user_uuid uuid not null references public.users(uuid) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists idx_password_resets_expires_at on public.password_resets(expires_at);

-- Optional: if you enable RLS later, create policies that fit your security model.
-- This server uses the service role key and should be treated as trusted backend code.


-- API keys are validated server-side. We store a SHA-256 hash (key_hash) instead of requiring plaintext keys.
-- Backward compatibility: api_key column may exist from older installs; the server accepts either.
alter table if exists api_keys add column if not exists key_hash text;
alter table if exists api_keys add column if not exists key_prefix text;

create unique index if not exists api_keys_key_hash_uq on api_keys (key_hash);
create index if not exists api_keys_user_uuid_idx on api_keys (user_uuid);

