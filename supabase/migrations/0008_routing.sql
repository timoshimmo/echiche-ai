-- M7: deterministic complexity routing (ADR-010).
--   * requested_depth: what the user asked for (auto | quick | standard | deep).
--   * route_tier / route_reasons / route_policy_version: the router's decision and why,
--     recorded when the run is queued (config/routing-policy.json, versioned).
--   * route_escalation: set by the worker if the policy escalated synthesis to a stronger model.
alter table echiche.thought_runs
  add column requested_depth text not null default 'auto' check (requested_depth in ('auto', 'quick', 'standard', 'deep')),
  add column route_tier text check (route_tier is null or route_tier in ('low', 'medium', 'high')),
  add column route_reasons jsonb not null default '[]' check (jsonb_typeof(route_reasons) = 'array'),
  add column route_policy_version text check (route_policy_version is null or route_policy_version ~ '^routing-policy\.v[0-9]+$'),
  add column route_escalation text check (route_escalation is null or char_length(route_escalation) <= 300);

grant insert (requested_depth, route_tier, route_reasons, route_policy_version) on echiche.thought_runs to echiche_end_user;
grant update (route_escalation) on echiche.thought_runs to echiche_worker;
